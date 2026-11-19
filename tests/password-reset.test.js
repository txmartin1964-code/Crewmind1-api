/**
 * tests/password-reset.test.js
 *
 * Unit tests for the tenant password-reset flow's pure mechanics
 * (lib/password-reset.js): token generation, SHA-256 storage hashing,
 * the 1-hour expiry / single-use rules, the reset URL shape, and the
 * request validation the POST /api/auth/reset-password endpoint uses.
 * The endpoint itself needs a live DB, so it is covered here through
 * the exact helpers it calls — validation and token-state decisions
 * must not drift between the two.
 * Plain node + assert — the repo has no test framework.
 * Run: node tests/password-reset.test.js
 */

const assert = require('node:assert');
const {
  TOKEN_TTL_MS, MIN_PASSWORD_LENGTH, INVALID_LINK_MESSAGE,
  generateToken, hashToken, tokenExpiresAt, isTokenExpired,
  isTokenUsable, validateNewPassword, validateResetRequest, buildResetUrl,
} = require('../lib/password-reset');

let passed = 0;
function check(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  passed++;
  console.log(`  ok — ${label}`);
}

// --- token generation ---------------------------------------------------------

const tokenA = generateToken();
const tokenB = generateToken();
check('tokens are unique', tokenA !== tokenB, true);
check('token is url-safe (no +, /, = or spaces)', /^[A-Za-z0-9_-]+$/.test(tokenA), true);
check('token carries at least 32 bytes of entropy (43+ base64url chars)', tokenA.length >= 43, true);

// --- hashing: stored value is never the raw token -----------------------------

const stored = hashToken(tokenA);
check('stored hash never equals the raw token', stored !== tokenA, true);
check('hash is 64-char hex (SHA-256)', /^[0-9a-f]{64}$/.test(stored), true);
check('hash is deterministic — same token hashes the same for lookup', hashToken(tokenA), stored);
check('different tokens hash differently', hashToken(tokenB) !== stored, true);
check('hashing is one-way in practice: hashing the hash does not return the token', hashToken(stored) !== tokenA, true);

// --- expiry logic ---------------------------------------------------------------

const t0 = new Date('2026-11-19T12:00:00.000Z');
const expires = tokenExpiresAt(t0);
check('expiry is exactly 1 hour after creation', expires.getTime() - t0.getTime(), TOKEN_TTL_MS);
check('TTL is 1 hour', TOKEN_TTL_MS, 60 * 60 * 1000);
check('not expired one minute before the deadline', isTokenExpired(expires, new Date(t0.getTime() + TOKEN_TTL_MS - 60000)), false);
check('expired at the deadline', isTokenExpired(expires, expires), true);
check('expired an hour after the deadline', isTokenExpired(expires, new Date(t0.getTime() + 2 * TOKEN_TTL_MS)), true);
check('a missing expiry counts as expired', isTokenExpired(null, t0), true);
check('string timestamps from the DB work too', isTokenExpired(expires.toISOString(), t0), false);

// --- single-use / usability -----------------------------------------------------

const freshRow = { expires_at: expires, used_at: null };
check('fresh, unused, unexpired token is usable', isTokenUsable(freshRow, t0), true);
check('a used token is not usable', isTokenUsable({ ...freshRow, used_at: t0 }, t0), false);
check('an expired token is not usable', isTokenUsable(freshRow, new Date(t0.getTime() + 2 * TOKEN_TTL_MS)), false);
check('a missing token row is not usable', isTokenUsable(null, t0), false);
check('a used AND expired token is not usable', isTokenUsable({ expires_at: t0, used_at: t0 }, t0), false);

// --- password rule (same as signup: 8+) -----------------------------------------

check('minimum length matches the signup rule', MIN_PASSWORD_LENGTH, 8);
check('empty password is rejected', validateNewPassword('') !== null, true);
check('7-char password is rejected', validateNewPassword('1234567') !== null, true);
check('8-char password is accepted', validateNewPassword('12345678'), null);
check('long password is accepted', validateNewPassword('a much longer passphrase'), null);
check('rejection message names the rule', /at least 8 characters/.test(validateNewPassword('short')), true);

// --- endpoint request validation (POST /api/auth/reset-password) -----------------

check('missing token -> invalid-link error', validateResetRequest({ password: '12345678' }).error, INVALID_LINK_MESSAGE);
check('blank token -> invalid-link error', validateResetRequest({ token: '  ', password: '12345678' }).error, INVALID_LINK_MESSAGE);
check('missing body -> invalid-link error', validateResetRequest(undefined).error, INVALID_LINK_MESSAGE);
check('missing password -> password error', /at least 8/.test(validateResetRequest({ token: tokenA }).error), true);
check('short password -> password error', /at least 8/.test(validateResetRequest({ token: tokenA, password: 'short' }).error), true);
const valid = validateResetRequest({ token: `  ${tokenA}  `, password: 'new-password-1' });
check('valid request passes validation', valid.error, null);
check('valid request trims the token', valid.token, tokenA);
check('valid request keeps the password untouched', valid.password, 'new-password-1');

// --- reset URL --------------------------------------------------------------------

check('reset URL uses the app base + token param', buildResetUrl('abc123', 'https://example.com'), 'https://example.com/reset-password.html?token=abc123');
check('reset URL tolerates a trailing slash on the base', buildResetUrl('abc123', 'https://example.com/'), 'https://example.com/reset-password.html?token=abc123');
check('reset URL defaults to the production app', buildResetUrl('abc123'), 'https://crewmind1-api.onrender.com/reset-password.html?token=abc123');
check('reset URL round-trips a generated token', buildResetUrl(tokenA).includes(`token=${tokenA}`), true);

console.log(`\nAll ${passed} assertions passed.`);
