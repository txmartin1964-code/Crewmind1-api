/**
 * lib/app-login.js
 * Owns: Pure validation for the admin-set tenant app login
 * (POST /api/admin/tenants/:id/app-login) — email normalization/format,
 * the shared new-password rule, and the email-uniqueness decision. No
 * DB or HTTP in here, so all of it is unit-testable in isolation.
 * Does NOT own: tenant persistence (db/tenants.js), password hashing
 * (lib/auth.js bcrypt), or the HTTP endpoint (routes/admin.js).
 */

const { validateNewPassword } = require('./password-reset');

const INVALID_EMAIL_MESSAGE = 'Enter a valid email address.';
const EMAIL_IN_USE_MESSAGE = 'That email is already used by another account.';

// Deliberately a reasonable format check, not full RFC 5322: one "@",
// no whitespace, a dot in the domain with something on both sides.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Canonical form stored on the tenant row: trimmed + lowercased. */
function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

/** Returns an error string, or null when the email is acceptable. */
function validateEmail(raw) {
  const email = normalizeEmail(raw);
  if (!email || !EMAIL_PATTERN.test(email)) return INVALID_EMAIL_MESSAGE;
  return null;
}

/**
 * Request-shape validation for POST /api/admin/tenants/:id/app-login,
 * kept here so the endpoint and the tests share exactly one rule set.
 * The password rule is the same one signup and password-reset use
 * (8+ characters, lib/password-reset.js).
 * Returns { email, password, error } — email is normalized; error is
 * null when valid.
 */
function validateAppLoginRequest(body) {
  const email = normalizeEmail(body?.email);
  const password = String(body?.password || '');
  const emailError = validateEmail(email);
  if (emailError) return { email, password, error: emailError };
  const passwordError = validateNewPassword(password);
  if (passwordError) return { email, password, error: passwordError };
  return { email, password, error: null };
}

/**
 * Uniqueness decision: setting an email conflicts only when a tenant
 * OTHER than the target already uses it. Re-setting the target's own
 * current email (e.g. just to change the password) is fine.
 */
function emailConflict(existingTenant, targetId) {
  if (!existingTenant) return false;
  return Number(existingTenant.id) !== Number(targetId);
}

module.exports = {
  INVALID_EMAIL_MESSAGE,
  EMAIL_IN_USE_MESSAGE,
  normalizeEmail,
  validateEmail,
  validateAppLoginRequest,
  emailConflict,
};
