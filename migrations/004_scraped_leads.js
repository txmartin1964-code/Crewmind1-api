/**
 * migrations/004_scraped_leads.js
 *
 * Persistence for scraper results. Previously scrape results were returned
 * in the HTTP response and then lost; now every run is stored so leads can
 * be worked later. Dedupe is on (name, phone, query): re-running the same
 * search does not pile up copies of the same business, while the same
 * business found by a different search is kept (different outreach angle).
 */

module.exports = {
  name: '004_scraped_leads',

  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS scraped_leads (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(50) NOT NULL DEFAULT '',
        website TEXT,
        query TEXT NOT NULL,
        source VARCHAR(50),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS scraped_leads_dedupe_idx
        ON scraped_leads (name, phone, query);
    `);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS scraped_leads;`);
  }
};
