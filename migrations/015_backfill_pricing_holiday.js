/**
 * migrations/015_backfill_pricing_holiday.js
 *
 * Backfills any missing shared pricing defaults (lib/pricing-defaults.js)
 * into every existing tenant's price book — same generic sync as 014,
 * run again because holiday_lighting was added to the defaults after
 * 014 shipped. INSERT ... SELECT per tenant with ON CONFLICT DO
 * NOTHING: rows a tenant already has are never clobbered, so this only
 * lands the new holiday_lighting row (plus anything else still missing).
 */

const { PRICING_DEFAULTS: DEFAULTS } = require('../lib/pricing-defaults');

module.exports = {
  name: '015_backfill_pricing_holiday',

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
    // Best effort: remove only holiday_lighting rows that still match
    // the shipped default exactly (an untouched backfilled row). A
    // tuned row is the tenant's own data and stays.
    await client.query(
      `DELETE FROM pricing_rules
       WHERE job_type = 'holiday_lighting'
         AND base_price_cents = 35000
         AND price_per_sqft_cents = 300`
    );
  }
};
