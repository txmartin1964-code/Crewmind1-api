/**
 * migrations/007_usage.js
 *
 * Usage metering for the Phase 2 plan caps. One row per metered event:
 *   kind = 'ai_qualified_lead'  — an AI qualification that produced a
 *                                 score and did NOT disqualify the lead
 *                                 (spam/disqualified leads are never
 *                                 recorded, hence never charged).
 *   kind = 'scraped_prospect'   — one prospect saved by the scraper.
 * Monthly totals are SUM(qty) over the current calendar month.
 */

module.exports = {
  name: '007_usage',

  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        kind VARCHAR(50) NOT NULL,
        qty INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS usage_events_tenant_kind_month_idx
        ON usage_events (tenant_id, kind, created_at);
    `);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS usage_events;`);
  }
};
