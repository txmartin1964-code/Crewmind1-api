/**
 * db/usage.js
 * Owns: All database queries for usage_events (migration 007).
 * Does NOT own: cap policy (services/usage.js).
 */

const pool = require('./index');

async function recordUsage(tenantId, kind, qty = 1) {
  await pool.query(
    'INSERT INTO usage_events (tenant_id, kind, qty) VALUES ($1, $2, $3)',
    [tenantId, kind, qty]
  );
}

/** Totals for the current calendar month, keyed by kind. */
async function getMonthlyUsage(tenantId) {
  const result = await pool.query(
    `SELECT kind, COALESCE(SUM(qty), 0)::int AS total
     FROM usage_events
     WHERE tenant_id = $1 AND created_at >= DATE_TRUNC('month', NOW())
     GROUP BY kind`,
    [tenantId]
  );
  const usage = {};
  for (const row of result.rows) usage[row.kind] = row.total;
  return usage;
}

module.exports = { recordUsage, getMonthlyUsage };
