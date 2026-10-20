/**
 * migrations/009_change_orders.js
 *
 * Change orders (Phase 2, Item 5). A change order is created against a
 * job, then approved (e-signed) or declined by the customer through a
 * token link — the same signing machinery pattern as contracts
 * (migration 005): unguessable token, typed-name signature, SHA-256 of
 * the document stored at signing time. Approved change orders add to
 * the job's final invoice total.
 */

module.exports = {
  name: '009_change_orders',

  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS change_orders (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL DEFAULT 1,
        job_id INTEGER NOT NULL,
        description TEXT NOT NULL,
        amount_cents INTEGER NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        token VARCHAR(64) UNIQUE NOT NULL,
        token_expires_at TIMESTAMPTZ,
        signed_name VARCHAR(255),
        signature_hash VARCHAR(64),
        signed_at TIMESTAMPTZ,
        signer_ip VARCHAR(64),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS change_orders_job_idx ON change_orders (job_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS change_orders_tenant_idx ON change_orders (tenant_id);`);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS change_orders;`);
  }
};
