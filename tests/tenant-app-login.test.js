/**
 * tests/tenant-app-login.test.js
 *
 * Unit tests for the admin-set tenant app login's pure validation
 * (lib/app-login.js): email normalization/format, the shared 8+
 * password rule, the request validation POST
 * /api/admin/tenants/:id/app-login uses, and the email-uniqueness
 * decision (409 only when a DIFFERENT tenant owns the email). The
 * endpoint itself needs a live DB, so it is covered here through the
 * exact helpers it calls — validation and the uniqueness decision must
 * not drift between the two.
 * Plain node + assert — the repo has no test framework.
 * Run: node tests/tenant-app-login.test.js
 */

const assert = require('node:assert');
const {
  INVALID_EMAIL_MESSAGE, EMAIL_IN_USE_MESSAGE,
  normalizeEmail, validateEmail, validateAppLoginRequest, emailConflict,
} = require('../lib/app-login');

let passed = 0;
function check(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  passed++;
  console.log(`  ok — ${label}`);
}

// --- email normalization --------------------------------------------------------

check('normalization trims and lowercases', normalizeEmail('  Owner@Example.COM '), 'owner@example.com');
check('normalization of empty input is empty string', normalizeEmail(''), '');
check('normalization of missing input is empty string', normalizeEmail(undefined), '');
check('normalization of null input is empty string', normalizeEmail(null), '');

// --- email format -----------------------------------------------------------------

check('plain address is valid', validateEmail('owner@example.com'), null);
check('address with plus tag and subdomain is valid', validateEmail('owner+app@mail.example.co'), null);
check('uppercase address is valid after normalization', validateEmail('OWNER@EXAMPLE.COM'), null);
check('missing email is invalid', validateEmail(''), INVALID_EMAIL_MESSAGE);
check('missing email (undefined) is invalid', validateEmail(undefined), INVALID_EMAIL_MESSAGE);
check('no @ is invalid', validateEmail('owner.example.com'), INVALID_EMAIL_MESSAGE);
check('no dot in domain is invalid', validateEmail('owner@example'), INVALID_EMAIL_MESSAGE);
check('nothing before @ is invalid', validateEmail('@example.com'), INVALID_EMAIL_MESSAGE);
check('nothing after @ is invalid', validateEmail('owner@'), INVALID_EMAIL_MESSAGE);
check('whitespace inside is invalid', validateEmail('ow ner@example.com'), INVALID_EMAIL_MESSAGE);
check('double @ is invalid', validateEmail('a@@example.com'), INVALID_EMAIL_MESSAGE);
check('trailing dot with empty TLD is invalid', validateEmail('owner@example.'), INVALID_EMAIL_MESSAGE);

// --- endpoint request validation (POST /api/admin/tenants/:id/app-login) -----------

check('missing body -> email error', validateAppLoginRequest(undefined).error, INVALID_EMAIL_MESSAGE);
check('missing email -> email error', validateAppLoginRequest({ password: '12345678' }).error, INVALID_EMAIL_MESSAGE);
check('invalid email -> email error', validateAppLoginRequest({ email: 'nope', password: '12345678' }).error, INVALID_EMAIL_MESSAGE);
check('email error wins over password error', validateAppLoginRequest({ email: 'nope', password: 'x' }).error, INVALID_EMAIL_MESSAGE);
check('missing password -> password error', /at least 8/.test(validateAppLoginRequest({ email: 'a@b.co' }).error), true);
check('empty password -> password error', /at least 8/.test(validateAppLoginRequest({ email: 'a@b.co', password: '' }).error), true);
check('7-char password -> password error', /at least 8/.test(validateAppLoginRequest({ email: 'a@b.co', password: '1234567' }).error), true);
const valid = validateAppLoginRequest({ email: '  Owner@Example.com ', password: 'new-password-1' });
check('valid request passes validation', valid.error, null);
check('valid request returns the normalized email', valid.email, 'owner@example.com');
check('valid request keeps the password untouched', valid.password, 'new-password-1');
check('8-char password is accepted', validateAppLoginRequest({ email: 'a@b.co', password: '12345678' }).error, null);

// --- uniqueness decision -------------------------------------------------------------

check('conflict message is the contract string', EMAIL_IN_USE_MESSAGE, 'That email is already used by another account.');
check('no existing tenant -> no conflict', emailConflict(null, 1), false);
check('no existing tenant (undefined) -> no conflict', emailConflict(undefined, 1), false);
check('same tenant re-setting its own email -> no conflict', emailConflict({ id: 1 }, 1), false);
check('same tenant, string id from the route -> no conflict', emailConflict({ id: 1 }, '1'), false);
check('different tenant owns the email -> conflict', emailConflict({ id: 2 }, 1), true);
check('different tenant, string target id -> conflict', emailConflict({ id: 2 }, '1'), true);
check('operator (id 1) taking a customer email -> conflict', emailConflict({ id: 7 }, 1), true);

console.log(`\nAll ${passed} assertions passed.`);
