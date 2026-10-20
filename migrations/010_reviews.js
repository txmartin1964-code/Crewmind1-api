/**
 * migrations/010_reviews.js
 *
 * Review bot (Phase 2, Item 6). One review_requests row per job:
 * created when the job is completed (the tenant confirms send/skip),
 * tracks the email, the customer's private feedback, and the thank-you.
 * The public ask is identical for every customer — "Share on Google"
 * and "Tell us privately" side by side, no sentiment gating.
 */

module.exports = {
  name: '010_reviews',

  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS review_requests (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL DEFAULT 1,
        job_id INTEGER NOT NULL,
        lead_id INTEGER,
        token VARCHAR(64) UNIQUE NOT NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'pending_prompt',
        sent_at TIMESTAMPTZ,
        feedback_text TEXT,
        feedback_rating INTEGER,
        feedback_at TIMESTAMPTZ,
        thanks_sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS review_requests_job_idx ON review_requests (job_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS review_requests_tenant_idx ON review_requests (tenant_id);`);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS review_requests;`);
  }
};
