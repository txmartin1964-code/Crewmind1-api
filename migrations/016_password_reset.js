/**
 * migrations/016_password_reset.js
 *
 * Tenant password reset (forgot-password flow).
 *   password_reset_tokens — one row per reset request. Only the SHA-256
 *                hash of the token is stored (the raw token lives only
 *                in the emailed link), so a database leak does not hand
 *                out usable reset links.
 *   token_hash — indexed for the lookup on POST /api/auth/reset-password.
 *   expires_at — links are valid for 1 hour from creation.
 *   used_at    — NULL until the token is spent; tokens are single-use,
 *                and requesting a new link invalidates prior unused ones.
 */

module.exports = {
  name: '016_password_reset',

  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id SERIAL PRIMARY KEY,
        tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS password_reset_tokens_token_hash_idx ON password_reset_tokens (token_hash);`);
    await client.query(`CREATE INDEX IF NOT EXISTS password_reset_tokens_tenant_id_idx ON password_reset_tokens (tenant_id);`);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS password_reset_tokens;`);
  }
};
