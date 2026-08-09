/**
 * services/quote-engine.js
 * Owns: Quote calculation logic from pricing rules.
 * Does NOT own: DB writes (db/quotes.js), email delivery (services/email.js).
 */

const { getPricingRules } = require('../db/quotes');

/**
 * Generates a quote for a lead given its job_type and sqft.
 * Returns the quote data ready to pass to createQuote().
 */
async function generateQuote(lead) {
  const rules = await getPricingRules();
  const rule = rules.find(r => r.job_type === lead.job_type) || rules.find(r => r.job_type === 'other');

  if (!rule) {
    throw new Error(`No pricing rule found for job type: ${lead.job_type}`);
  }

  const base_price_cents = rule.base_price_cents;
  const sqft = lead.sqft || 0;
  const sqft_price_cents = sqft > 0 ? rule.price_per_sqft_cents * sqft : 0;
  const total_cents = base_price_cents + sqft_price_cents;

  const line_items = [
    {
      label: rule.display_name + ' — Base Price',
      amount_cents: base_price_cents,
    },
  ];

  if (sqft_price_cents > 0) {
    line_items.push({
      label: `${sqft.toLocaleString()} sq ft @ $${(rule.price_per_sqft_cents / 100).toFixed(2)}/sqft`,
      amount_cents: sqft_price_cents,
    });
  }

  const notes = rule.notes
    ? `Estimate notes: ${rule.notes}\n\nThis is a preliminary estimate based on job type and size. Final pricing confirmed during on-site visit.`
    : 'This is a preliminary estimate. Final pricing confirmed during on-site visit.';

  return {
    lead_id: lead.id,
    job_type: lead.job_type,
    base_price_cents,
    sqft_price_cents,
    total_cents,
    line_items,
    notes,
  };
}

module.exports = { generateQuote };
