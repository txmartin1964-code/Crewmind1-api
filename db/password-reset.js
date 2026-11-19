/**
 * db/password-reset.js
 * Owns: All database queries for the password_reset_tokens table
 * (migration 016).
 * Does NOT own: token generation/hashing/expiry rules
 * (lib/password-reset.js), HTTP handling (routes/auth.js), or tenant
 * CRUD (db/tenants.js).
 */

const pool = require('./index');

/**
 * Store a new reset token for a tenant. Requesting a new link
 * invalidates every prior unused token for that tenant first, so only
 * the freshest link can ever work.
 */
async function createResetToken(tenantId, tokenHash, expiresAt) {
  await invalidateUnusedTokens(tenantId);
  const result = await pool.query(
    `INSERT INTO password_reset_tokens (tenant_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [tenantId, tokenHash, expiresAt]
  );
  return result.rows[0];
}

async function getResetTokenByHash(tokenHash) {
  if (!tokenHash) return null;
  const result = await pool.query(
    'SELECT * FROM password_reset_tokens WHERE token_hash = $1',
    [tokenHash]
  );
  return result.rows[0] || null;
}

/** Mark a token spent (single-use). Stamps used_at only once. */
async function markResetTokenUsed(id) {
  const result = await pool.query(
    `UPDATE password_reset_tokens SET used_at = NOW()
     WHERE id = $1 AND used_at IS NULL
     RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Invalidate unused tokens for a tenant by stamping used_at — a spent
 * token and a superseded token are indistinguishable on lookup, which
 * is the point. `exceptId` keeps one token alive (the one just used to
 * complete a reset does its own invalidation of the rest).
 */
async function invalidateUnusedTokens(tenantId, exceptId = null) {
  const result = await pool.query(
    `UPDATE password_reset_tokens SET used_at = NOW()
     WHERE tenant_id = $1 AND used_at IS NULL AND ($2::int IS NULL OR id <> $2)
     RETURNING id`,
    [tenantId, exceptId]
  );
  return result.rowCount;
}

module.exports = {
  createResetToken,
  getResetTokenByHash,
  markResetTokenUsed,
  invalidateUnusedTokens,
};
