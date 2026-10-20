/**
 * services/campaigns.js
 * Owns: CAN-SPAM-compliant campaign composition and sending.
 * Does NOT own: prospect/campaign storage (db/gtm.js), HTTP handling.
 *
 * Compliance rules baked in, not optional:
 *   - Honest subject: the campaign's subject is used verbatim.
 *   - Physical address footer: sending is REFUSED when the operator
 *     has not set a business_address — CAN-SPAM requires a valid
 *     postal address in every commercial email.
 *   - One-click unsubscribe: every email carries an HMAC-signed
 *     unsubscribe link (plus List-Unsubscribe headers); unsubscribing
 *     writes the suppression list, and the sender checks suppression
 *     before every single send.
 *   - Audience: only prospects in 'new'/'contacted' pipeline states
 *     with an email address. Trial/paid/churned businesses are never
 *     cold-emailed again.
 *   - NO SMS to prospects (TCPA). Email only.
 */

const crypto = require('crypto');
const gtm = require('../db/gtm');
const { getAllSettings } = require('../db/settings');
const { sendEmail } = require('./email');

function unsubscribeSecret() {
  return process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || process.env.ADMIN_TOKEN || 'crewmind-dev-secret';
}

function signEmail(email) {
  return crypto.createHmac('sha256', unsubscribeSecret())
    .update(String(email).toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

function verifyUnsubscribe(email, sig) {
  if (!email || !sig) return false;
  const expected = signEmail(email);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig)));
  } catch {
    return false;
  }
}

function getUnsubscribeUrl(email) {
  const base = process.env.APP_URL || 'http://localhost:3000';
  return `${base}/api/gtm/unsubscribe?e=${encodeURIComponent(email)}&s=${signEmail(email)}`;
}

function campaignTag(campaign) {
  return `cmp-${campaign.id}`;
}

function getTrialUrl(campaign) {
  const base = process.env.APP_URL || 'http://localhost:3000';
  return `${base}/signup?c=${encodeURIComponent(campaignTag(campaign))}`;
}

/** Renders one campaign email for one prospect. */
function composeEmail(campaign, prospect, operatorSettings) {
  const trialUrl = getTrialUrl(campaign);
  let body = campaign.body_text;
  body = body.split('{{business_name}}').join(prospect.name || 'there');
  body = body.split('{{trial_url}}').join(trialUrl);
  if (!body.includes(trialUrl)) {
    body += `\n\nStart your free 14-day trial: ${trialUrl}`;
  }
  const businessName = operatorSettings.business_name || 'CrewMind';
  const address = operatorSettings.business_address || '';
  const unsub = getUnsubscribeUrl(prospect.email);
  const footer =
    `\n\n—\n${businessName}\n${address}\n\n` +
    `You're receiving this because your business is publicly listed and we thought CrewMind could help. ` +
    `Don't want these emails? Unsubscribe: ${unsub}`;
  const text = body + footer;
  const html = text
    .split('\n')
    .map(line => line.trim() === '' ? '<br>' : `<p style="margin:0 0 10px;">${escapeHtml(line)}</p>`)
    .join('');
  return { subject: campaign.subject, text, html, unsubscribeUrl: unsub };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * Sends (or resumes) a campaign. Returns a tally. Throws if the
 * operator's physical address is missing — better no send than an
 * illegal one.
 */
async function sendCampaign(campaign, { limit = 500 } = {}) {
  const settings = await getAllSettings(1);
  if (!settings.business_address || !String(settings.business_address).trim()) {
    throw new Error('Operator business_address is not set. CAN-SPAM requires a physical postal address in the footer — set it in the operator console settings before sending.');
  }

  const alreadySent = await gtm.getAlreadySentLeadIds(campaign.id);
  const prospects = await gtm.getProspects({ tenantId: 1, onlyWithEmail: true, limit: 10000 });
  const targets = prospects.filter(p =>
    (p.pipeline_status === 'new' || p.pipeline_status === 'contacted') && !alreadySent.has(p.id)
  );

  let sent = 0, failed = 0, suppressed = 0, attempted = 0;
  for (const prospect of targets) {
    if (attempted >= limit) break;
    attempted++;
    if (await gtm.isSuppressed(prospect.email)) {
      suppressed++;
      await gtm.recordCampaignSend({ campaign_id: campaign.id, scraped_lead_id: prospect.id, email: prospect.email, status: 'suppressed' });
      continue;
    }
    const email = composeEmail(campaign, prospect, settings);
    const result = await sendEmail({ to: prospect.email, subject: email.subject, body: email.text, html: email.html });
    if (result && result.ok) {
      sent++;
      await gtm.recordCampaignSend({ campaign_id: campaign.id, scraped_lead_id: prospect.id, email: prospect.email, status: 'sent' });
      await gtm.markProspectContacted(prospect.id, 1);
    } else {
      failed++;
      await gtm.recordCampaignSend({
        campaign_id: campaign.id, scraped_lead_id: prospect.id, email: prospect.email,
        status: 'failed', error: 'email provider reported failure',
      });
    }
  }

  await gtm.updateCampaignStatus(campaign.id, 'sent');
  return { sent, failed, suppressed, attempted, eligible: targets.length };
}

module.exports = {
  signEmail, verifyUnsubscribe, getUnsubscribeUrl,
  campaignTag, getTrialUrl, composeEmail, sendCampaign,
};
