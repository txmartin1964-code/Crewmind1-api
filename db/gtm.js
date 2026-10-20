/**
 * db/gtm.js
 * Owns: All database queries for the GTM engine (migration 011):
 * prospect pipeline, campaigns, send log, suppression list.
 * Does NOT own: scraped-lead ingestion (db/scraped-leads.js), campaign
 * composition/sending (services/campaigns.js).
 */

const pool = require('./index');

const PIPELINE_STATUSES = ['new', 'contacted', 'trial', 'paid', 'churned'];

async function getProspects({ tenantId = 1, status, onlyWithEmail = false, limit = 100, offset = 0 } = {}) {
  const params = [tenantId];
  let where = 'WHERE tenant_id=$1';
  if (status) { params.push(status); where += ` AND pipeline_status=$${params.length}`; }
  if (onlyWithEmail) where += ` AND email IS NOT NULL AND email <> ''`;
  params.push(limit, offset);
  const result = await pool.query(
    `SELECT * FROM scraped_leads ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return result.rows;
}

async function getProspectCounts(tenantId = 1) {
  const result = await pool.query(
    `SELECT pipeline_status, COUNT(*)::int AS count
     FROM scraped_leads WHERE tenant_id=$1 GROUP BY pipeline_status`,
    [tenantId]
  );
  const counts = Object.fromEntries(PIPELINE_STATUSES.map(s => [s, 0]));
  for (const row of result.rows) counts[row.pipeline_status] = row.count;
  return counts;
}

async function updateProspectStatus(id, status, tenantId = 1) {
  const result = await pool.query(
    `UPDATE scraped_leads SET pipeline_status=$1 WHERE id=$2 AND tenant_id=$3 RETURNING *`,
    [status, id, tenantId]
  );
  return result.rows[0] || null;
}

async function markProspectContacted(id, tenantId = 1) {
  await pool.query(
    `UPDATE scraped_leads
     SET pipeline_status = CASE WHEN pipeline_status='new' THEN 'contacted' ELSE pipeline_status END,
         last_contacted_at = NOW()
     WHERE id=$1 AND tenant_id=$2`,
    [id, tenantId]
  );
}

async function findProspectByEmail(email, tenantId = 1) {
  const result = await pool.query(
    'SELECT * FROM scraped_leads WHERE tenant_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1',
    [tenantId, email]
  );
  return result.rows[0] || null;
}

/* ---------------- Suppressions ---------------- */

async function addSuppression(email, reason = 'unsubscribe') {
  await pool.query(
    `INSERT INTO email_suppressions (email, reason) VALUES (LOWER($1), $2)
     ON CONFLICT (email) DO NOTHING`,
    [email, reason]
  );
}

async function isSuppressed(email) {
  if (!email) return false;
  const result = await pool.query(
    'SELECT 1 FROM email_suppressions WHERE email=LOWER($1)', [email]
  );
  return result.rows.length > 0;
}

async function listSuppressions(limit = 500) {
  const result = await pool.query(
    'SELECT * FROM email_suppressions ORDER BY created_at DESC LIMIT $1', [limit]
  );
  return result.rows;
}

/* ---------------- Campaigns ---------------- */

async function createCampaign({ tenant_id = 1, name, subject, body_text }) {
  const result = await pool.query(
    `INSERT INTO campaigns (tenant_id, name, subject, body_text)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [tenant_id, name, subject, body_text]
  );
  return result.rows[0];
}

async function getCampaignById(id) {
  const result = await pool.query('SELECT * FROM campaigns WHERE id=$1', [id]);
  return result.rows[0] || null;
}

async function getCampaigns(tenantId = 1) {
  const result = await pool.query(
    `SELECT c.*,
       (SELECT COUNT(*)::int FROM campaign_sends s WHERE s.campaign_id=c.id AND s.status='sent') AS sent_count,
       (SELECT COUNT(*)::int FROM campaign_sends s WHERE s.campaign_id=c.id AND s.status='failed') AS failed_count,
       (SELECT COUNT(*)::int FROM campaign_sends s WHERE s.campaign_id=c.id AND s.status='suppressed') AS suppressed_count
     FROM campaigns c WHERE c.tenant_id=$1 ORDER BY c.created_at DESC`,
    [tenantId]
  );
  return result.rows;
}

async function updateCampaignStatus(id, status) {
  const result = await pool.query(
    `UPDATE campaigns SET status=$1::varchar, sent_at = CASE WHEN $1::varchar='sent' THEN NOW() ELSE sent_at END
     WHERE id=$2 RETURNING *`,
    [status, id]
  );
  return result.rows[0] || null;
}

async function recordCampaignSend({ campaign_id, scraped_lead_id, email, status, error = null }) {
  await pool.query(
    `INSERT INTO campaign_sends (campaign_id, scraped_lead_id, email, status, error)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (campaign_id, scraped_lead_id) DO NOTHING`,
    [campaign_id, scraped_lead_id, email, status, error]
  );
}

async function getAlreadySentLeadIds(campaignId) {
  const result = await pool.query(
    'SELECT scraped_lead_id FROM campaign_sends WHERE campaign_id=$1', [campaignId]
  );
  return new Set(result.rows.map(r => r.scraped_lead_id));
}

module.exports = {
  PIPELINE_STATUSES,
  getProspects, getProspectCounts, updateProspectStatus, markProspectContacted,
  findProspectByEmail,
  addSuppression, isSuppressed, listSuppressions,
  createCampaign, getCampaignById, getCampaigns, updateCampaignStatus,
  recordCampaignSend, getAlreadySentLeadIds,
};
