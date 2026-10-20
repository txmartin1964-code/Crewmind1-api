/**
 * db/settings.js
 * Owns: All database queries for the app_settings key/value table
 * (created by migration 003, made per-tenant by migration 006).
 * Does NOT own: which settings exist or their validation (routes/).
 *
 * Every function takes a tenantId (default 1 = the operator tenant) so
 * Phase 1 call sites keep working unchanged while tenant-facing code
 * passes the tenant's own id.
 */

const pool = require('./index');

async function getAllSettings(tenantId = 1) {
  const result = await pool.query(
    'SELECT key, value FROM app_settings WHERE tenant_id=$1',
    [tenantId]
  );
  const settings = {};
  for (const row of result.rows) settings[row.key] = row.value;
  return settings;
}

async function getSetting(key, fallback = null, tenantId = 1) {
  const result = await pool.query(
    'SELECT value FROM app_settings WHERE key=$1 AND tenant_id=$2',
    [key, tenantId]
  );
  return result.rows.length ? result.rows[0].value : fallback;
}

async function setSetting(key, value, tenantId = 1) {
  await pool.query(
    `INSERT INTO app_settings (tenant_id, key, value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [tenantId, key, value == null ? null : String(value)]
  );
}

module.exports = { getAllSettings, getSetting, setSetting };
