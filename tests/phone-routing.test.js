/**
 * tests/phone-routing.test.js
 *
 * Unit tests for the Phase 10 phone-module routing core
 * (lib/phone-routing.js): E.164-ish normalization, the layered
 * routing decision (ring-through toggle > personal whitelist > sort),
 * and the personal-sort intent check. These protect the module's core
 * promise — a personal call must never be eaten by the AI.
 * Plain node + assert — the repo has no test framework.
 * Run: node tests/phone-routing.test.js
 */

const assert = require('node:assert');
const { normalizePhone, decideRoute, isPersonalSort } = require('../lib/phone-routing');

let passed = 0;
function check(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  passed++;
  console.log(`  ok — ${label}`);
}

// --- normalizePhone ----------------------------------------------------------

check('bare 10-digit US', normalizePhone('8175550100'), '+18175550100');
check('formatted US', normalizePhone('(817) 555-0100'), '+18175550100');
check('dashed US', normalizePhone('817-555-0100'), '+18175550100');
check('11-digit with country code', normalizePhone('18175550100'), '+18175550100');
check('already E.164', normalizePhone('+18175550100'), '+18175550100');
check('E.164 with spaces', normalizePhone('+1 817 555 0100'), '+18175550100');
check('UK international', normalizePhone('+44 20 7946 0958'), '+442079460958');
check('00 international prefix', normalizePhone('00442079460958'), '+442079460958');
check('null input', normalizePhone(null), null);
check('empty string', normalizePhone(''), null);
check('letters only', normalizePhone('call me maybe'), null);
check('too short', normalizePhone('5550100'), null);
check('too long', normalizePhone('+1234567890123456'), null);

// --- decideRoute ---------------------------------------------------------------

const now = new Date('2026-10-23T12:00:00.000Z');
const inThirty = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
const thirtyAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
const baseSettings = { ownerNumber: '+19405550100', ringThroughUntil: null, afterHours: false };

const toggleOn = decideRoute({ callerNumber: '+18175550199', settings: { ...baseSettings, ringThroughUntil: inThirty }, whitelistMatch: false, now });
check('toggle active rings the owner', toggleOn.action, 'ring_owner');
check('toggle route label', toggleOn.route, 'toggle_ringthrough');

const toggleBeatsWhitelist = decideRoute({ callerNumber: '+18175550199', settings: { ...baseSettings, ringThroughUntil: inThirty }, whitelistMatch: true, now });
check('toggle beats whitelist (priority order)', toggleBeatsWhitelist.route, 'toggle_ringthrough');

const whitelisted = decideRoute({ callerNumber: '+18175550199', settings: baseSettings, whitelistMatch: true, now });
check('whitelist rings the owner', whitelisted.action, 'ring_owner');
check('whitelist route label', whitelisted.route, 'whitelist_ringthrough');

const unknown = decideRoute({ callerNumber: '+18175550199', settings: baseSettings, whitelistMatch: false, now });
check('unknown caller goes to the sort', unknown.action, 'sort');

const expiredToggle = decideRoute({ callerNumber: '+18175550199', settings: { ...baseSettings, ringThroughUntil: thirtyAgo }, whitelistMatch: false, now });
check('expired toggle falls through to sort', expiredToggle.action, 'sort');

const expiredToggleWhitelist = decideRoute({ callerNumber: '+18175550199', settings: { ...baseSettings, ringThroughUntil: thirtyAgo }, whitelistMatch: true, now });
check('expired toggle still honors the whitelist', expiredToggleWhitelist.route, 'whitelist_ringthrough');

const toggleAtExpiry = decideRoute({ callerNumber: '+18175550199', settings: { ...baseSettings, ringThroughUntil: now.toISOString() }, whitelistMatch: false, now });
check('toggle expiring exactly now is off', toggleAtExpiry.action, 'sort');

const noOwnerToggle = decideRoute({ callerNumber: '+18175550199', settings: { ownerNumber: '', ringThroughUntil: inThirty }, whitelistMatch: false, now });
check('toggle with no owner number degrades to sort', noOwnerToggle.action, 'sort');

const noOwnerWhitelist = decideRoute({ callerNumber: '+18175550199', settings: { ownerNumber: null, ringThroughUntil: null }, whitelistMatch: true, now });
check('whitelist with no owner number degrades to sort', noOwnerWhitelist.action, 'sort');

const afterHoursIrrelevant = decideRoute({ callerNumber: '+18175550199', settings: { ...baseSettings, afterHours: true }, whitelistMatch: true, now });
check('after-hours flag does not eat a personal call', afterHoursIrrelevant.route, 'whitelist_ringthrough');

// --- isPersonalSort ------------------------------------------------------------

check('DTMF 2 is personal', isPersonalSort({ digits: '2' }), true);
check('speech "personal" is personal', isPersonalSort({ speechResult: 'personal' }), true);
check('speech "This is a personal call" is personal', isPersonalSort({ speechResult: 'This is a personal call' }), true);
check('speech "PERSONAL please" is personal', isPersonalSort({ speechResult: 'PERSONAL please' }), true);
check('DTMF 1 stays business', isPersonalSort({ digits: '1' }), false);
check('business speech stays business', isPersonalSort({ speechResult: 'I need a roof repair quote' }), false);
check('silence stays business', isPersonalSort({}), false);
check('"personnel" is not the word personal', isPersonalSort({ speechResult: 'personnel department' }), false);

console.log(`\nAll ${passed} assertions passed.`);
