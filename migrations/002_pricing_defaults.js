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

const DEFAULTS = [
  // job_type, display_name, base_price_cents, price_per_sqft_cents, notes
  ['roof_repair',        'Roof Repair',        45000,  150,  'Starting ballpark for leak/patch repairs. Final price after roof inspection.'],
  ['roof_replacement',   'Roof Replacement',   150000, 450,  'Ballpark for tear-off and re-shingle. Final price after roof inspection.'],
  ['gutter_cleaning',    'Gutter Cleaning',    17500,  0,    'Flat service price for a standard single-story home.'],
  ['siding_repair',      'Siding Repair',      40000,  200,  'Ballpark for localized siding repair. Final price on site.'],
  ['window_install',     'Window Installation', 65000, 0,    'Priced per window opening, standard size. Final price on site.'],
  ['deck_build',         'Deck Build',         80000,  3500, 'Ballpark per sq ft of deck area, standard lumber. Final price on site.'],
  ['hvac_service',       'HVAC Service',       25000,  15,   'Service call and diagnostic ballpark. Repairs quoted on site.'],
  ['painting_exterior',  'Exterior Painting',  80000,  225,  'Ballpark for full exterior repaint. Final price on site.'],
  ['plumbing_repair',    'Plumbing Repair',    22500,  0,    'Service call ballpark. Repair scope quoted on site.'],
  ['electrical',         'Electrical',         25000,  0,    'Service call ballpark. Scope quoted on site.'],
  ['landscaping',        'Landscaping',        35000,  20,   'Ballpark for cleanup and basic landscaping. Final price on site.'],
  ['other',              'General Service',    25000,  50,   'General service ballpark. Final price confirmed on site.'],
];

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
