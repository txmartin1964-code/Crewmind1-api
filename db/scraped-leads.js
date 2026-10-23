/**
 * db/scraped-leads.js
 * Owns: All database queries for the scraped_leads table.
 * Does NOT own: the scraping itself (scraperService.js), HTTP handling (server.js).
 */

const pool = require('./index');

/**
 * Persists scraper results, deduplicating on (tenant_id, name, phone,
 * query) via the unique index from migrations 004/006.
 *
 * Heal-on-rescrape: the v1 feed-only scraper stored rows with empty
 * phone and no email. When a later, better run finds the same business
 * again under the same query, we UPDATE that row — filling blanks with
 * whatever the new run found — instead of inserting a duplicate or
 * leaving the gaps in place. Values already present are kept; only
 * empty ones are replaced. A healed row counts as a duplicate.
 *
 * Returns { saved, duplicates } counts.
 */
async function saveScrapedLeads(leads, { query, source, tenantId = 1 } = {}) {
  let saved = 0;
  let duplicates = 0;

  for (const lead of leads || []) {
    if (!lead || !lead.name) continue;

    const phone = lead.phone || '';
    const website = lead.website || null;
    const email = lead.email || null;
    const queryText = query || '';

    const existing = await pool.query(
      `SELECT id, phone, website, email FROM scraped_leads
        WHERE tenant_id = $1 AND name = $2 AND query = $3
        LIMIT 1`,
      [tenantId, lead.name, queryText]
    );

    if (existing.rows.length) {
      const row = existing.rows[0];
      const healedPhone = row.phone || phone;
      const healedWebsite = row.website || website;
      const healedEmail = row.email || email;

      if (healedPhone !== row.phone || healedWebsite !== row.website || healedEmail !== row.email) {
        try {
          await pool.query(
            `UPDATE scraped_leads SET phone = $1, website = $2, email = $3 WHERE id = $4`,
            [healedPhone, healedWebsite, healedEmail, row.id]
          );
        } catch (err) {
          // A new phone can collide with the (tenant_id, name, phone,
          // query) unique index when a sibling row already carries it.
          // Not fatal — the data exists on that row already.
          console.error(`saveScrapedLeads: heal update failed for scraped_lead ${row.id}: ${err.message}`);
        }
      }
      duplicates++;
      continue;
    }

    const result = await pool.query(
      `INSERT INTO scraped_leads (tenant_id, name, phone, website, email, query, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, name, phone, query) DO NOTHING
       RETURNING id`,
      [tenantId, lead.name, phone, website, email, queryText, source || null]
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
