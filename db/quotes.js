/**
 * db/quotes.js
 * Owns: All database queries for the quotes table.
 * Does NOT own: pricing calculation logic (services/), HTTP handling (routes/).
 */

const pool = require('./index');

async function createQuote(data) {
  const { lead_id, job_type, base_price_cents, sqft_price_cents, total_cents, line_items, notes } = data;
  const valid_until = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days
  const result = await pool.query(
    `INSERT INTO quotes (lead_id, job_type, base_price_cents, sqft_price_cents, total_cents, line_items, notes, valid_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [lead_id, job_type, base_price_cents, sqft_price_cents, total_cents,
     JSON.stringify(line_items || []), notes || null, valid_until]
  );
  return result.rows[0];
}

async function updateQuoteStatus(quoteId, status) {
  const updates = { status };
  if (status === 'sent') updates.sent_at = new Date();
  if (status === 'accepted' || status === 'declined') updates.responded_at = new Date();

  const result = await pool.query(
    `UPDATE quotes
     SET status=$1, sent_at=COALESCE($2, sent_at), responded_at=COALESCE($3, responded_at), updated_at=NOW()
     WHERE id=$4
     RETURNING *`,
    [status, updates.sent_at || null, updates.responded_at || null, quoteId]
  );
  return result.rows[0];
}

async function getQuoteByLeadId(leadId) {
  const result = await pool.query(
    'SELECT * FROM quotes WHERE lead_id=$1 ORDER BY id DESC LIMIT 1',
    [leadId]
  );
  return result.rows[0] || null;
}

async function getPricingRules() {
  const result = await pool.query(
    'SELECT * FROM pricing_rules WHERE is_active=TRUE ORDER BY display_name'
  );
  return result.rows;
}

async function updatePricingRule(id, { base_price_cents, price_per_sqft_cents, notes }) {
  const result = await pool.query(
    `UPDATE pricing_rules
     SET base_price_cents=$1, price_per_sqft_cents=$2, notes=$3, updated_at=NOW()
     WHERE id=$4
     RETURNING *`,
    [base_price_cents, price_per_sqft_cents, notes || null, id]
  );
  return result.rows[0];
}

module.exports = { createQuote, updateQuoteStatus, getQuoteByLeadId, getPricingRules, updatePricingRule };
