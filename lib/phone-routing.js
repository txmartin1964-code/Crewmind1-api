/**
 * lib/phone-routing.js
 * Owns: PURE phone-routing decisions for the Phase 10 phone module —
 * number normalization, the ring-through / whitelist / sort decision,
 * and the personal-sort intent check. No I/O, no DB, no env: every
 * function is unit-testable in isolation (tests/phone-routing.test.js).
 * Does NOT own: TwiML rendering or webhook handling (routes/phone.js),
 * persistence (db/phone.js).
 *
 * The design (crewmind-notes/phone-module-personal-call-routing.md):
 * contractors run the business on their personal number, so the AI
 * must never hijack personal calls. Layered routing:
 *   1. Ring-through toggle (owner is expecting a personal call)
 *   2. Personal contacts whitelist (family never hears a menu)
 *   3. Everyone else: honest AI greeting + conversational sort
 * A personal ring-through the owner doesn't answer cascades to message
 * capture in routes/phone.js — never a dead end.
 */

/**
 * Normalize a phone number to E.164-ish form ("+1" + 10 digits for US
 * numbers). Accepts formatted input ("(817) 555-0100", "817-555-0100",
 * "+44 20 7946 0958", "011 44 ..."). Returns null when the input can't
 * plausibly be a phone number — callers must treat null as "no match",
 * never as a wildcard.
 */
function normalizePhone(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;

  let international = false;
  if (s.startsWith('+')) {
    international = true;
    s = s.slice(1);
  } else if (s.startsWith('00')) {
    international = true;
    s = s.slice(2);
  }

  const digits = s.replace(/\D/g, '');
  if (!digits) return null;

  if (international) {
    // E.164: country code + number, 8–15 digits total, no leading zero.
    if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) return null;
    return '+' + digits;
  }

  // Bare national number: assume US/NANP.
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

/**
 * Decide how an inbound call is routed.
 *
 * @param {object} input
 * @param {string} input.callerNumber   Caller's number (any format; normalized here).
 * @param {object} input.settings       Tenant phone settings:
 *        { ownerNumber, ringThroughUntil (Date|string|null), afterHours }.
 *        afterHours is stored/console-managed in v1 and does NOT change
 *        the decision: the whitelist + sort layers already protect
 *        personal calls around the clock. It is carried here so the
 *        settings shape stays in one place for later phases.
 * @param {boolean} input.whitelistMatch  Caller is on the personal list.
 * @param {Date} [input.now]            Injectable clock for tests.
 * @returns {{ action: 'ring_owner'|'sort', route: string, reason: string }}
 *   route is the call_log vocabulary for ring decisions
 *   ('toggle_ringthrough' | 'whitelist_ringthrough'); for the sort
 *   action it is 'sort' — the final sort_business / sort_personal
 *   value is only known after the caller answers the greeting.
 */
function decideRoute({ callerNumber, settings, whitelistMatch, now } = {}) {
  const s = settings || {};
  const at = now instanceof Date ? now : new Date(now || Date.now());
  const owner = normalizePhone(s.ownerNumber);

  // Priority 1 — temporary ring-through mode beats everything: the
  // owner flipped it because they're expecting a personal call.
  const until = s.ringThroughUntil ? new Date(s.ringThroughUntil) : null;
  const toggleActive = !!(until && !Number.isNaN(until.getTime()) && until.getTime() > at.getTime());
  if (toggleActive) {
    if (owner) return { action: 'ring_owner', route: 'toggle_ringthrough', reason: 'ring-through mode is on' };
    return { action: 'sort', route: 'sort', reason: 'ring-through on but no owner number set — sorting instead' };
  }

  // Priority 2 — personal whitelist: ring straight through, no menu.
  if (whitelistMatch) {
    if (owner) return { action: 'ring_owner', route: 'whitelist_ringthrough', reason: 'caller is on the personal list' };
    return { action: 'sort', route: 'sort', reason: 'caller is on the personal list but no owner number set — sorting instead' };
  }

  // Priority 3 — unknown caller: AI greeting + conversational sort.
  return { action: 'sort', route: 'sort', reason: 'unknown caller' };
}

/**
 * Did the caller ask for the owner personally at the sort greeting?
 * Speech containing the word "personal", or DTMF 2 (the greeting says
 * "say 'personal' or press 2"). Anything else — including silence —
 * stays on the business path: the greeting is a business greeting and
 * business is the honest default.
 */
function isPersonalSort({ speechResult, digits } = {}) {
  if (String(digits || '').trim() === '2') return true;
  if (speechResult && /\bpersonal\b/i.test(String(speechResult))) return true;
  return false;
}

module.exports = { normalizePhone, decideRoute, isPersonalSort };
