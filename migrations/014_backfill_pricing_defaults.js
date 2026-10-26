/**
 * migrations/014_backfill_pricing_defaults.js
 *
 * Backfills any missing shared pricing defaults (lib/pricing-defaults.js)
 * into every existing tenant's price book. Onboarding seeds a new tenant's
 * book from the defaults, but defaults added later (flooring_install and
 * carpet_cleaning, Oct 2026) never reached books created earlier —
 * including the operator's own (tenant 1).
 *
 * INSERT ... SELECT per tenant with ON CONFLICT DO NOTHING: rows a tenant
 * already has — tuned or not — are never clobbered.
 */

const { PRICING_DEFAULTS: DEFAULTS } = require('../lib/pricing-defaults');

module.exports = {
  name: '014_backfill_pricing_defaults',

  up: async (client) => {
    for (const [job_type, display_name, base, perSqft, notes] of DEFAULTS) {
      await client.query(
        `INSERT INTO pricing_rules (tenant_id, job_type, display_name, base_price_cents, price_per_sqft_cents, notes, is_active)
         SELECT t.id, $1, $2, $3, $4, $5, TRUE FROM tenants t
         ON CONFLICT (tenant_id, job_type) DO NOTHING`,
        [job_type, display_name, base, perSqft, notes]
      );
    }
  },

  down: async (client) => {
    // Best effort: remove only carpet_cleaning rows that still match the
    // shipped default exactly (an untouched backfilled row). Flooring rows
    // are left in place — removing a trade's pricing on rollback would
    // break quotes for it, and a tuned row is the tenant's own data.
    await client.query(
      `DELETE FROM pricing_rules
       WHERE job_type = 'carpet_cleaning'
         AND base_price_cents = 15000
         AND price_per_sqft_cents = 30`
    );
  }
};
