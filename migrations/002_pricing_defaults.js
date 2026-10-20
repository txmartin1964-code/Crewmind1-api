/**
 * migrations/002_pricing_defaults.js
 *
 * Seeds real, nonzero default pricing rules for every job type offered on
 * the intake form (public/get-quote.html). Migration 001 only seeded a
 * placeholder 'other' rule at $0/$0, which meant every generated quote
 * totaled $0.00.
 *
 * These defaults are contractor ballparks, not final prices — the owner is
 * expected to tune them in the admin console (PATCH /api/admin/pricing/:id).
 *
 * Two-step approach so existing data is handled correctly:
 *   1. INSERT all 12 rules, skipping any job_type that already has a row.
 *   2. UPDATE any of the 12 rows that are still priced at $0/$0 (notably
 *      the placeholder 'other' row from 001) to the defaults. Rows with
 *      real prices already set are never clobbered.
 */

const { PRICING_DEFAULTS: DEFAULTS } = require('../lib/pricing-defaults');

module.exports = {
  name: '002_pricing_defaults',

  up: async (client) => {
    // 1. Insert any missing rules.
    for (const [job_type, display_name, base, perSqft, notes] of DEFAULTS) {
      await client.query(
        `INSERT INTO pricing_rules (job_type, display_name, base_price_cents, price_per_sqft_cents, notes, is_active)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         ON CONFLICT (job_type) DO NOTHING`,
        [job_type, display_name, base, perSqft, notes]
      );
    }

    // 2. Repair rows that still sit at the $0/$0 placeholder (e.g. the
    //    'other' row seeded by migration 001).
    for (const [job_type, , base, perSqft, notes] of DEFAULTS) {
      await client.query(
        `UPDATE pricing_rules
         SET base_price_cents = $2, price_per_sqft_cents = $3, notes = $4, updated_at = NOW()
         WHERE job_type = $1 AND base_price_cents = 0 AND price_per_sqft_cents = 0`,
        [job_type, base, perSqft, notes]
      );
    }
  },

  down: async (client) => {
    // Best effort: remove the rules this migration inserted and reset
    // 'other' to its migration-001 placeholder state.
    await client.query(
      `DELETE FROM pricing_rules WHERE job_type = ANY($1)`,
      [DEFAULTS.map(d => d[0]).filter(t => t !== 'other')]
    );
    await client.query(
      `UPDATE pricing_rules
       SET base_price_cents = 0, price_per_sqft_cents = 0,
           notes = 'Placeholder rule — update pricing in the admin dashboard before going live.',
           updated_at = NOW()
       WHERE job_type = 'other'`
    );
  }
};
