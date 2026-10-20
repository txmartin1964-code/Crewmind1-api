/**
 * migrations/011_gtm.js
 *
 * GTM engine (Phase 2, Item 7) — the operator's prospect pipeline.
 *   scraped_leads gains a pipeline_status (new/contacted/trial/paid/
 *   churned) and last_contacted_at.
 *   campaigns        — operator email campaigns to prospects.
 *   campaign_sends   — per-recipient send log (sent/failed/suppressed).
 *   email_suppressions — the CAN-SPAM suppression list; anyone who
 *   unsubscribes (or is added manually) is never emailed again.
 */

module.exports = {
  name: '011_gtm',

  up: async (client) => {
    await client.query(`ALTER TABLE scraped_leads ADD COLUMN IF NOT EXISTS pipeline_status VARCHAR(20) NOT NULL DEFAULT 'new';`);
    await client.query(`ALTER TABLE scraped_leads ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ;`);
    await client.query(`CREATE INDEX IF NOT EXISTS scraped_leads_pipeline_idx ON scraped_leads (tenant_id, pipeline_status);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_suppressions (
        email VARCHAR(255) PRIMARY KEY,
        reason VARCHAR(100),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL DEFAULT 1,
        name VARCHAR(255) NOT NULL,
        subject VARCHAR(255) NOT NULL,
        body_text TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'draft',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        sent_at TIMESTAMPTZ
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS campaign_sends (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        scraped_lead_id INTEGER,
        email VARCHAR(255) NOT NULL,
        status VARCHAR(20) NOT NULL,
        error TEXT,
        sent_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (campaign_id, scraped_lead_id)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS campaign_sends_campaign_idx ON campaign_sends (campaign_id);`);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS campaign_sends;`);
    await client.query(`DROP TABLE IF EXISTS campaigns;`);
    await client.query(`DROP TABLE IF EXISTS email_suppressions;`);
    await client.query(`ALTER TABLE scraped_leads DROP COLUMN IF EXISTS pipeline_status;`);
    await client.query(`ALTER TABLE scraped_leads DROP COLUMN IF EXISTS last_contacted_at;`);
  }
};
