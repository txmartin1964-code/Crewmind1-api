/**
 * services/usage.js
 * Owns: Plan cap policy for metered features.
 * Does NOT own: usage storage (db/usage.js), billing (services/billing.js).
 *
 * Included in Core, per tenant per calendar month:
 *   - 200 AI-qualified leads (a qualification counts when the AI returns
 *     a score and the lead is NOT disqualified — spam and disqualified
 *     leads never count and are never charged).
 *   - 500 scraped prospects (hard cap; no overage for prospects).
 *
 * Lead overage: a tenant may opt in (setting overage_enabled='true') and
 * set their own ceiling (setting overage_cap_leads = max overage leads
 * per month). Overage is billed at $10–15 per lead (see README) — this
 * module only meters and gates; it never invents charges beyond the
 * recorded usage.
 *
 * The operator tenant (Keith) is exempt from caps.
 */

const { getMonthlyUsage } = require('../db/usage');
const { getSetting } = require('../db/settings');

const INCLUDED = {
  ai_qualified_lead: 200,
  scraped_prospect: 500,
};

async function getUsageSummary(tenant) {
  const usage = await getMonthlyUsage(tenant.id);
  return {
    ai_qualified_leads: {
      used: usage.ai_qualified_lead || 0,
      included: INCLUDED.ai_qualified_lead,
    },
    scraped_prospects: {
      used: usage.scraped_prospect || 0,
      included: INCLUDED.scraped_prospect,
    },
  };
}

/**
 * Decides whether one more unit of `kind` may be consumed right now.
 * Returns { allowed, overage, used, included, reason }.
 */
async function checkCap(tenant, kind) {
  const included = INCLUDED[kind];
  if (included === undefined) return { allowed: true, overage: false, used: 0, included: 0 };
  if (!tenant || tenant.is_operator) {
    return { allowed: true, overage: false, used: 0, included };
  }

  const usage = await getMonthlyUsage(tenant.id);
  const used = usage[kind] || 0;
  if (used < included) return { allowed: true, overage: false, used, included };

  // Included allowance exhausted. Leads may continue as paid overage if
  // the tenant opted in and is under their own ceiling.
  if (kind === 'ai_qualified_lead') {
    const enabled = (await getSetting('overage_enabled', 'false', tenant.id)) === 'true';
    const capRaw = parseInt(await getSetting('overage_cap_leads', '0', tenant.id), 10);
    const cap = Number.isNaN(capRaw) ? 0 : capRaw;
    const overageUsed = used - included;
    if (enabled && overageUsed < cap) {
      return { allowed: true, overage: true, used, included };
    }
    return {
      allowed: false, overage: false, used, included,
      reason: enabled
        ? 'Monthly AI-qualified lead overage ceiling reached.'
        : 'Monthly AI-qualified lead allowance reached and overage is not enabled.',
    };
  }

  return { allowed: false, overage: false, used, included, reason: 'Monthly allowance reached.' };
}

module.exports = { INCLUDED, getUsageSummary, checkCap };
