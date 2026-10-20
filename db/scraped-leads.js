/**
 * db/scraped-leads.js
 * Owns: All database queries for the scraped_leads table.
 * Does NOT own: the scraping itself (scraperService.js), HTTP handling (server.js).
 */

const pool = require('./index');

/**
 * Persists scraper results, deduplicating on (tenant_id, name, phone,
 * query) via the unique index from migrations 004/006.
 * Returns { saved, duplicates } counts.
 */
async function saveScrapedLeads(leads, { query, source, tenantId = 1 } = {}) {
  let saved = 0;
  let duplicates = 0;

  for (const lead of leads || []) {
    if (!lead || !lead.name) continue;
    const result = await pool.query(
      `INSERT INTO scraped_leads (tenant_id, name, phone, website, email, query, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, name, phone, query) DO NOTHING
       RETURNING id`,
      [tenantId, lead.name, lead.phone || '', lead.website || null, lead.email || null, query || '', source || null]
    );
    if (result.rows.length) saved++;
    else duplicates++;
  }

  return { saved, duplicates };
}

async function getScrapedLeadById(id) {
  const result = await pool.query('SELECT * FROM scraped_leads WHERE id=$1', [id]);
  return result.rows[0] || null;
}

module.exports = { saveScrapedLeads, getScrapedLeadById };


