/**
 * db/settings.js
 * Owns: All database queries for the app_settings key/value table
 * (created by migration 003).
 * Does NOT own: which settings exist or their validation (routes/admin.js,
 * services/payments.js).
 */

const pool = require('./index');

async function getAllSettings() {
  const result = await pool.query('SELECT key, value FROM app_settings');
  const settings = {};
  for (const row of result.rows) settings[row.key] = row.value;
  return settings;
}

async function getSetting(key, fallback = null) {
  const result = await pool.query('SELECT value FROM app_settings WHERE key=$1', [key]);
  return result.rows.length ? result.rows[0].value : fallback;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value == null ? null : String(value)]
  );
}

module.exports = { getAllSettings, getSetting, setSetting };
