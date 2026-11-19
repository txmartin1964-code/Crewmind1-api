/**
 * lib/password-reset.js
 * Owns: Pure password-reset token mechanics — generating the raw token,
 * hashing it for storage/lookup, the 1-hour expiry rule, single-use
 * checks, and the shared new-password / reset-request validation. No DB
 * or HTTP in here, so all of it is unit-testable in isolation.
 * Does NOT own: token persistence (db/password-reset.js), the HTTP
 * endpoints (routes/auth.js), password hashing for the tenants table
 * (lib/auth.js bcrypt), or sending the email (services/email.js).
 */

const crypto = require('crypto');

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const MIN_PASSWORD_LENGTH = 8; // same rule as signup (routes/signup.js)

const INVALID_LINK_MESSAGE = 'This reset link is invalid or has expired. Request a new one.';
const GENERIC_FORGOT_MESSAGE = 'If an account exists for that email, a reset link is on its way.';

/** Raw token for the emailed link: 32 random bytes, URL-safe. */
function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * The value that gets stored in the DB and looked up on reset. SHA-256
 * is deterministic (the same raw token always hashes the same way, so
 * lookup works) and one-way (the stored value is never the raw token).
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** When a token created at `now` stops working. */
function tokenExpiresAt(now = new Date()) {
  return new Date(new Date(now).getTime() + TOKEN_TTL_MS);
}

function isTokenExpired(expiresAt, now = new Date()) {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() <= new Date(now).getTime();
}

/**
 * A stored token row is usable only if it exists, has not been spent,
 * and has not expired.
 */
function isTokenUsable(row, now = new Date()) {
  if (!row) return false;
  if (row.used_at) return false;
  return !isTokenExpired(row.expires_at, now);
}

/** Returns an error string, or null when the password is acceptable. */
function validateNewPassword(password) {
  if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

/**
 * Request-shape validation for POST /api/auth/reset-password, kept here
 * so the endpoint and the tests share exactly one rule set.
 * Returns { token, password, error } — error is null when valid.
 */
function validateResetRequest(body) {
  const token = String(body?.token || '').trim();
  const password = String(body?.password || '');
  if (!token) return { token, password, error: INVALID_LINK_MESSAGE };
  const passwordError = validateNewPassword(password);
  if (passwordError) return { token, password, error: passwordError };
  return { token, password, error: null };
}

function buildResetUrl(rawToken, appUrl) {
  const base = String(appUrl || 'https://crewmind1-api.onrender.com').replace(/\/+$/, '');
  return `${base}/reset-password.html?token=${encodeURIComponent(rawToken)}`;
}

module.exports = {
  TOKEN_TTL_MS,
  MIN_PASSWORD_LENGTH,
  INVALID_LINK_MESSAGE,
  GENERIC_FORGOT_MESSAGE,
  generateToken,
  hashToken,
  tokenExpiresAt,
  isTokenExpired,
  isTokenUsable,
  validateNewPassword,
  validateResetRequest,
  buildResetUrl,
};
