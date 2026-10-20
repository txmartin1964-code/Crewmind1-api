/**
 * migrations/008_jobs_invoices.js
 *
 * Jobs and final invoices (Phase 2, Item 4).
 *   jobs        — a unit of work for a tenant, grown from a lead/quote/
 *                 appointment. Completing a job is the trigger for the
 *                 final invoice (Item 4) and the review bot (Item 6).
 *   invoices    — money documents. kind 'final' = balance due after the
 *                 deposit (quote total + approved change orders minus
 *                 deposit paid). Paid via Stripe through the same
 *                 redirector pattern as quote deposits.
 *   job_events  — the audit/review log that hangs off a job: completion,
 *                 invoice sends, payments, review requests, feedback.
 */

module.exports = {
  name: '008_jobs_invoices',

  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL DEFAULT 1,
        lead_id INTEGER,
        quote_id INTEGER,
        appointment_id INTEGER,
        title VARCHAR(255),
        status VARCHAR(30) NOT NULL DEFAULT 'scheduled',
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS jobs_tenant_idx ON jobs (tenant_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS jobs_lead_idx ON jobs (lead_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS jobs_quote_idx ON jobs (quote_id);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL DEFAULT 1,
        job_id INTEGER,
        quote_id INTEGER,
        invoice_number VARCHAR(40),
        kind VARCHAR(20) NOT NULL DEFAULT 'final',
        total_cents INTEGER NOT NULL DEFAULT 0,
        deposit_paid_cents INTEGER NOT NULL DEFAULT 0,
        change_orders_cents INTEGER NOT NULL DEFAULT 0,
        amount_due_cents INTEGER NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'draft',
        stripe_session_id VARCHAR(255),
        stripe_payment_intent_id VARCHAR(255),
        sent_at TIMESTAMPTZ,
        paid_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS invoices_tenant_idx ON invoices (tenant_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS invoices_job_idx ON invoices (job_id);`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS invoices_stripe_session_idx ON invoices (stripe_session_id) WHERE stripe_session_id IS NOT NULL;`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS job_events (
        id SERIAL PRIMARY KEY,
        job_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL DEFAULT 1,
        event_type VARCHAR(50) NOT NULL,
        detail JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events (job_id, created_at);`);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS job_events;`);
    await client.query(`DROP TABLE IF EXISTS invoices;`);
    await client.query(`DROP TABLE IF EXISTS jobs;`);
  }
};
