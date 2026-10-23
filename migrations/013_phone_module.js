/**
 * migrations/013_phone_module.js
 *
 * Phone module (Phase 10) — personal/business call routing on one number.
 *   personal_contacts — the owner's personal pass-through list. A caller
 *                       on this list rings the owner straight through:
 *                       no greeting menu, no AI, ever.
 *   call_log          — one row per routed inbound call: who called,
 *                       which route the call took, and (when the call
 *                       ended in message capture) the recording +
 *                       transcription Twilio posts back.
 *
 * Per-tenant phone SETTINGS (owner number, greeting name, CrewMind
 * number, ring-through-until, after-hours, enabled flag) deliberately
 * live in the existing app_settings key/value table via db/settings.js —
 * no new settings table needed.
 */

module.exports = {
  name: '013_phone_module',

  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS personal_contacts (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL DEFAULT 1,
        name VARCHAR(255) NOT NULL,
        phone_e164 VARCHAR(32) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (tenant_id, phone_e164)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS personal_contacts_tenant_idx ON personal_contacts (tenant_id);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS call_log (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL DEFAULT 1,
        from_number VARCHAR(32),
        route_taken VARCHAR(40) NOT NULL,
        recording_url TEXT,
        transcription TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS call_log_tenant_idx ON call_log (tenant_id, created_at DESC);`);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS call_log;`);
    await client.query(`DROP TABLE IF EXISTS personal_contacts;`);
  }
};
