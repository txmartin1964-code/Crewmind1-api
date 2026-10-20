/**
 * migrations/003_payments.js
 *
 * Stripe payments support.
 * - Payment state lives on the QUOTE, not the appointment: the deposit is a
 *   percentage of the quote total and the quote email is what asks for it,
 *   and a quote exists before any appointment is booked.
 * - app_settings is a tiny key/value settings table. It holds the deposit
 *   percent and the business identity used in emails and contracts, all
 *   editable from the admin console (GET/PATCH /api/admin/settings) so the
 *   owner never has to touch code or env vars to change them.
 */

module.exports = {
  name: '003_payments',

  up: async (client) => {
    // 1. Payment columns on quotes.
    await client.query(`
      ALTER TABLE quotes
        ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50) DEFAULT 'unpaid',
        ADD COLUMN IF NOT EXISTS amount_paid_cents INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS stripe_checkout_session_id VARCHAR(255),
        ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(255),
        ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
    `);
    await client.query(`
      UPDATE quotes SET payment_status = 'unpaid' WHERE payment_status IS NULL;
    `);

    // 2. Settings table + defaults (insert-if-missing, never clobbers
    //    values the owner has already changed in the console).
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    const defaults = [
      ['deposit_percent', '20'],
      ['business_name', 'CrewMind'],
      ['business_address', ''],
      ['business_phone', ''],
    ];
    for (const [key, value] of defaults) {
      await client.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO NOTHING`,
        [key, value]
      );
    }
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS app_settings;`);
    await client.query(`
      ALTER TABLE quotes
        DROP COLUMN IF EXISTS payment_status,
        DROP COLUMN IF EXISTS amount_paid_cents,
        DROP COLUMN IF EXISTS stripe_checkout_session_id,
        DROP COLUMN IF EXISTS stripe_payment_intent_id,
        DROP COLUMN IF EXISTS paid_at;
    `);
  }
};
