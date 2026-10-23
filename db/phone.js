/**
 * db/phone.js
 * Owns: All database queries for the Phase 10 phone module —
 * personal_contacts, call_log (migration 013), and the per-tenant
 * phone settings stored in app_settings (via db/settings.js).
 * Does NOT own: routing decisions (lib/phone-routing.js), TwiML or
 * webhook handling (routes/phone.js), settings validation (routes/).
 *
 * Phone settings keys in app_settings:
 *   phone_enabled            'true' | 'false'
 *   phone_owner_number       owner's real cell, E.164 (ring-through target)
 *   phone_greeting_name      business name spoken in the AI greeting
 *   phone_number             the CrewMind/Twilio number callers dial —
 *                            this is the tenant mapping: an inbound call
 *                            to this number belongs to this tenant
 *   phone_ringthrough_until  ISO timestamp; while in the future, EVERY
 *                            call rings the owner (expecting-a-call mode)
 *   phone_after_hours        'true' | 'false' (stored for later phases)
 */

const pool = require('./index');
const { getAllSettings, setSetting } = require('./settings');
const { normalizePhone } = require('../lib/phone-routing');

async function getPhoneSettings(tenantId = 1) {
  const raw = await getAllSettings(tenantId);
  return {
    enabled: raw.phone_enabled === 'true',
    ownerNumber: raw.phone_owner_number || '',
    greetingName: raw.phone_greeting_name || '',
    phoneNumber: raw.phone_number || '',
    ringThroughUntil: raw.phone_ringthrough_until || null,
    afterHours: raw.phone_after_hours === 'true',
  };
}

/** Write only the fields present in `patch` (camelCase). Numbers are stored normalized. */
async function updatePhoneSettings(tenantId, patch = {}) {
  const writes = [];
  if (patch.enabled !== undefined) writes.push(['phone_enabled', patch.enabled ? 'true' : 'false']);
  if (patch.ownerNumber !== undefined) writes.push(['phone_owner_number', patch.ownerNumber ? normalizePhone(patch.ownerNumber) : null]);
  if (patch.greetingName !== undefined) writes.push(['phone_greeting_name', patch.greetingName || null]);
  if (patch.phoneNumber !== undefined) writes.push(['phone_number', patch.phoneNumber ? normalizePhone(patch.phoneNumber) : null]);
  if (patch.ringThroughUntil !== undefined) writes.push(['phone_ringthrough_until', patch.ringThroughUntil || null]);
  if (patch.afterHours !== undefined) writes.push(['phone_after_hours', patch.afterHours ? 'true' : 'false']);
  for (const [key, value] of writes) await setSetting(key, value, tenantId);
  return getPhoneSettings(tenantId);
}

/** Which tenant answers on this dialed number? Null when unclaimed. */
async function findTenantByDialedNumber(dialedE164) {
  if (!dialedE164) return null;
  const result = await pool.query(
    `SELECT tenant_id FROM app_settings WHERE key='phone_number' AND value=$1 LIMIT 1`,
    [dialedE164]
  );
  return result.rows.length ? result.rows[0].tenant_id : null;
}

// -- Personal contacts --------------------------------------------------------

async function listPersonalContacts(tenantId = 1) {
  const result = await pool.query(
    'SELECT id, name, phone_e164, created_at FROM personal_contacts WHERE tenant_id=$1 ORDER BY name ASC, id ASC',
    [tenantId]
  );
  return result.rows;
}

async function addPersonalContact(tenantId, { name, phoneE164 }) {
  const result = await pool.query(
    `INSERT INTO personal_contacts (tenant_id, name, phone_e164)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, phone_e164) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name, phone_e164, created_at`,
    [tenantId, name, phoneE164]
  );
  return result.rows[0];
}

async function deletePersonalContact(tenantId, id) {
  const result = await pool.query(
    'DELETE FROM personal_contacts WHERE tenant_id=$1 AND id=$2',
    [tenantId, id]
  );
  return result.rowCount > 0;
}

async function isPersonalContact(tenantId, phoneE164) {
  if (!phoneE164) return false;
  const result = await pool.query(
    'SELECT 1 FROM personal_contacts WHERE tenant_id=$1 AND phone_e164=$2 LIMIT 1',
    [tenantId, phoneE164]
  );
  return result.rows.length > 0;
}

// -- Call log -----------------------------------------------------------------

async function createCallLog(tenantId, { fromNumber, routeTaken }) {
  const result = await pool.query(
    `INSERT INTO call_log (tenant_id, from_number, route_taken)
     VALUES ($1, $2, $3)
     RETURNING id, tenant_id, from_number, route_taken, recording_url, transcription, created_at`,
    [tenantId, fromNumber || null, routeTaken]
  );
  return result.rows[0];
}

async function getCallLog(id) {
  const result = await pool.query('SELECT * FROM call_log WHERE id=$1', [id]);
  return result.rows.length ? result.rows[0] : null;
}

/** Patch keys (camelCase): routeTaken, recordingUrl, transcription. */
async function updateCallLog(id, patch = {}) {
  const cols = { routeTaken: 'route_taken', recordingUrl: 'recording_url', transcription: 'transcription' };
  const sets = [];
  const values = [];
  for (const [key, col] of Object.entries(cols)) {
    if (patch[key] !== undefined) { values.push(patch[key]); sets.push(`${col}=$${values.length}`); }
  }
  if (!sets.length) return getCallLog(id);
  values.push(id);
  const result = await pool.query(
    `UPDATE call_log SET ${sets.join(', ')} WHERE id=$${values.length} RETURNING *`,
    values
  );
  return result.rows.length ? result.rows[0] : null;
}

async function listCallLog(tenantId = 1, limit = 25) {
  const result = await pool.query(
    `SELECT id, from_number, route_taken, recording_url, transcription, created_at
     FROM call_log WHERE tenant_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [tenantId, limit]
  );
  return result.rows;
}

module.exports = {
  getPhoneSettings, updatePhoneSettings, findTenantByDialedNumber,
  listPersonalContacts, addPersonalContact, deletePersonalContact, isPersonalContact,
  createCallLog, getCallLog, updateCallLog, listCallLog,
};
