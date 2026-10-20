/**
 * db/scraped-leads.js
 * Owns: All database queries for the scraped_leads table.
 * Does NOT own: the scraping itself (scraperService.js), HTTP handling (server.js).
 */

const pool = require('./index');

/**
 * Persists scraper results, deduplicating on (name, phone, query) via the
 * unique index from migration 004.
 * Returns { saved, duplicates } counts.
 */
async function saveScrapedLeads(leads, { query, source } = {}) {
  let saved = 0;
  let duplicates = 0;

  for (const lead of leads || []) {
    if (!lead || !lead.name) continue;
    const result = await pool.query(
      `INSERT INTO scraped_leads (name, phone, website, query, source)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name, phone, query) DO NOTHING
       RETURNING id`,
      [lead.name, lead.phone || '', lead.website || null, query || '', source || null]
    );
    if (result.rows.length) saved++;
    else duplicates++;
  }

  return { saved, duplicates };
}

module.exports = { saveScrapedLeads };
