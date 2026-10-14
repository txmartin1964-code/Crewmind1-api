/**
 * migrations/001_lead_pipeline_schema.js
 *
 * Brings the Postgres schema in line with what the app code expects.
 * - Adds missing columns to the existing `leads` table (idempotent).
 * - Creates quotes, pricing_rules, appointments, available_slots tables (idempotent).
 * - Seeds a placeholder 'other' pricing rule so quote generation never throws
 *   on "No pricing rule found" (real prices must be set via the admin dashboard).
 *
 * Runs automatically at startup via server.js runMigrations().
 */

module.exports = {
  name: '001_lead_pipeline_schema',

  up: async (client) => {
    // 1. Columns that db/leads.js createLead() / updateLeadQualification() write.
    await client.query(`
      ALTER TABLE leads
        ADD COLUMN IF NOT EXISTS job_type VARCHAR(100),
        ADD COLUMN IF NOT EXISTS address VARCHAR(255),
        ADD COLUMN IF NOT EXISTS city VARCHAR(100),
        ADD COLUMN IF NOT EXISTS zip VARCHAR(20),
        ADD COLUMN IF NOT EXISTS sqft INTEGER,
        ADD COLUMN IF NOT EXISTS timeline VARCHAR(100),
        ADD COLUMN IF NOT EXISTS description TEXT,
        ADD COLUMN IF NOT EXISTS photo_urls TEXT,
        ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45),
        ADD COLUMN IF NOT EXISTS ai_score INTEGER,
        ADD COLUMN IF NOT EXISTS ai_reasoning TEXT,
        ADD COLUMN IF NOT EXISTS ai_flags TEXT,
        ADD COLUMN IF NOT EXISTS qualification_status VARCHAR(50),
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
    `);

    // 2. Quotes table (db/quotes.js createQuote / updateQuoteStatus).
    await client.query(`
      CREATE TABLE IF NOT EXISTS quotes (
        id SERIAL PRIMARY KEY,
        lead_id INTEGER,
        job_type VARCHAR(100),
        base_price_cents INTEGER,
        sqft_price_cents INTEGER,
        total_cents INTEGER,
        line_items TEXT,
        notes TEXT,
        status VARCHAR(50) DEFAULT 'draft',
        valid_until TIMESTAMPTZ,
        sent_at TIMESTAMPTZ,
        responded_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 3. Pricing rules table (db/quotes.js getPricingRules / updatePricingRule).
    await client.query(`
      CREATE TABLE IF NOT EXISTS pricing_rules (
        id SERIAL PRIMARY KEY,
        job_type VARCHAR(100) UNIQUE,
        display_name VARCHAR(255),
        base_price_cents INTEGER DEFAULT 0,
        price_per_sqft_cents INTEGER DEFAULT 0,
        notes TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 4. Seed fallback 'other' rule so generateQuote() never throws when no
    //    job-specific rule exists. Real prices must be set in the admin dashboard.
    await client.query(`
      INSERT INTO pricing_rules (job_type, display_name, base_price_cents, price_per_sqft_cents, notes, is_active)
      SELECT 'other', 'General Service', 0, 0,
             'Placeholder rule — update pricing in the admin dashboard before going live.', TRUE
      WHERE NOT EXISTS (SELECT 1 FROM pricing_rules WHERE job_type = 'other');
    `);

    // 5. Appointments + availability tables (db/appointments.js).
    await client.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id SERIAL PRIMARY KEY,
        lead_id INTEGER,
        quote_id INTEGER,
        scheduled_date DATE,
        scheduled_time VARCHAR(20),
        status VARCHAR(50) DEFAULT 'confirmed',
        confirmation_code VARCHAR(20) UNIQUE,
        confirmation_sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS available_slots (
        id SERIAL PRIMARY KEY,
        slot_date DATE,
        slot_time VARCHAR(20),
        max_bookings INTEGER DEFAULT 1,
        current_bookings INTEGER DEFAULT 0,
        is_blocked BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS available_slots;`);
    await client.query(`DROP TABLE IF EXISTS appointments;`);
    await client.query(`DROP TABLE IF EXISTS quotes;`);
    await client.query(`DROP TABLE IF EXISTS pricing_rules;`);
  }
};
