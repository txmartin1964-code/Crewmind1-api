/**
 * tests/phone-webhooks.test.js
 *
 * Endpoint-shape tests for the Phase 10 Twilio webhooks
 * (routes/phone.js), run against an in-memory fake of db/phone.js —
 * no database, no Twilio account. Covers: the inert 503 gate, the
 * unknown-number reject, whitelist ring-through, the sort greeting,
 * personal/business sort outcomes, the no-answer capture cascade,
 * recording + transcription capture, and Twilio signature validation
 * (valid passes, tampered/missing are 403, unset token = dev mode).
 * Plain node + assert — the repo has no test framework.
 * Run: node tests/phone-webhooks.test.js
 */

const assert = require('node:assert');
const crypto = require('node:crypto');
const express = require('express');
const { createPhoneRouter } = require('../routes/phone');

let passed = 0;
function check(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  passed++;
  console.log(`  ok — ${label}`);
}
function checkIncludes(label, haystack, needle) {
  assert.ok(String(haystack).includes(needle), `${label}: expected response to include ${JSON.stringify(needle)}, got: ${String(haystack).slice(0, 300)}`);
  passed++;
  console.log(`  ok — ${label}`);
}

// --- In-memory fake of the db/phone.js dependency surface ---------------------

function makeFakeDeps() {
  const settings = {
    enabled: true,
    ownerNumber: '+19405550100',
    greetingName: 'H&M General Contractors',
    phoneNumber: '+18175550100',
    ringThroughUntil: null,
    afterHours: false,
  };
  const contacts = new Set(['+18175550199']); // "Mom"
  const logs = [];
  let nextId = 1;
  return {
    _settings: settings,
    _logs: logs,
    async findTenantByDialedNumber(e164) { return e164 === settings.phoneNumber ? 1 : null; },
    async getPhoneSettings() { return settings; },
    async isPersonalContact(tenantId, e164) { return contacts.has(e164); },
    async createCallLog(tenantId, { fromNumber, routeTaken }) {
      const row = { id: nextId++, tenant_id: tenantId, from_number: fromNumber, route_taken: routeTaken, recording_url: null, transcription: null };
      logs.push(row);
      return row;
    },
    async getCallLog(id) { return logs.find((r) => r.id === id) || null; },
    async updateCallLog(id, patch) {
      const row = logs.find((r) => r.id === id);
      if (!row) return null;
      if (patch.routeTaken !== undefined) row.route_taken = patch.routeTaken;
      if (patch.recordingUrl !== undefined) row.recording_url = patch.recordingUrl;
      if (patch.transcription !== undefined) row.transcription = patch.transcription;
      return row;
    },
  };
}

async function main() {
  const savedSid = process.env.TWILIO_ACCOUNT_SID;
  const savedToken = process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;

  const deps = makeFakeDeps();
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/phone', createPhoneRouter(deps));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = async (path, params, headers = {}) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(params).toString(),
    });
    return { status: res.status, type: res.headers.get('content-type') || '', body: await res.text() };
  };
  const sign = (url, params, token) => {
    let data = url;
    for (const key of Object.keys(params).sort()) data += key + String(params[key]);
    return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
  };

  try {
    // --- Inert gate: no Twilio env → 503, even for a browser-style GET --------
    let r = await post('/api/phone/voice', { From: '+18175550199', To: '+18175550100' });
    check('unconfigured POST /voice is 503', r.status, 503);
    const getRes = await fetch(base + '/api/phone/voice');
    check('unconfigured GET /voice is 503 (not 404)', getRes.status, 503);
    await getRes.text();

    // --- Dev mode: SID set, no auth token → active, no signature checks -------
    process.env.TWILIO_ACCOUNT_SID = 'AC-test-sid';

    r = await post('/api/phone/voice', { From: '+18175550199', To: '+19999999999' });
    check('unknown dialed number still answers 200', r.status, 200);
    checkIncludes('unknown number gets the polite reject', r.body, 'this number is not in service');
    checkIncludes('response is TwiML', r.type, 'text/xml');

    r = await post('/api/phone/voice', { From: '+18175550199', To: '+18175550100' });
    check('whitelist caller gets 200', r.status, 200);
    checkIncludes('whitelist caller dials the owner', r.body, '<Dial');
    checkIncludes('dial targets the owner number', r.body, '+19405550100');
    checkIncludes('dial reports back to dial-status', r.body, '/api/phone/dial-status?log=');
    check('whitelist call logged as whitelist_ringthrough', deps._logs.at(-1).route_taken, 'whitelist_ringthrough');

    r = await post('/api/phone/voice', { From: '+12125550123', To: '+18175550100' });
    checkIncludes('unknown caller hears the gather greeting', r.body, '<Gather');
    checkIncludes('greeting names the business', r.body, 'H&amp;M General Contractors');
    checkIncludes('greeting is honest about being virtual', r.body, 'virtual assistant');
    checkIncludes('greeting offers the personal sort', r.body, 'press 2');
    const sortLogId = Number(r.body.match(/\/api\/phone\/sort\?log=(\d+)/)[1]);
    check('sort call provisionally logged as sort_business', deps._logs.at(-1).route_taken, 'sort_business');

    // --- Personal sort → dial owner → no-answer cascade → capture -------------
    r = await post(`/api/phone/sort?log=${sortLogId}`, { Digits: '2', To: '+18175550100', From: '+12125550123' });
    checkIncludes('press 2 dials the owner', r.body, '<Dial');
    check('log corrected to sort_personal', deps._logs.at(-1).route_taken, 'sort_personal');

    r = await post(`/api/phone/dial-status?log=${sortLogId}`, { DialCallStatus: 'no-answer' });
    checkIncludes('no-answer cascades to a recording', r.body, '<Record');
    checkIncludes('capture records with transcription on', r.body, 'transcribe="true"');
    check('log route becomes capture', deps._logs.at(-1).route_taken, 'capture');

    r = await post(`/api/phone/recording?log=${sortLogId}`, { RecordingUrl: 'https://api.twilio.com/recordings/RE123', RecordingSid: 'RE123' });
    check('recording action answers 200', r.status, 200);
    checkIncludes('recording action thanks the caller', r.body, "we've got your message");
    check('recording URL saved', deps._logs.at(-1).recording_url, 'https://api.twilio.com/recordings/RE123');

    r = await post(`/api/phone/recording?log=${sortLogId}`, { TranscriptionText: 'Hi, this is Mom, call me back.', TranscriptionStatus: 'completed' });
    check('transcription callback answers 200', r.status, 200);
    check('transcription saved', deps._logs.at(-1).transcription, 'Hi, this is Mom, call me back.');

    // --- Business sort → capture ---------------------------------------------
    r = await post('/api/phone/voice', { From: '+12125550124', To: '+18175550100' });
    const bizLogId = Number(r.body.match(/\/api\/phone\/sort\?log=(\d+)/)[1]);
    r = await post(`/api/phone/sort?log=${bizLogId}`, { SpeechResult: 'I need a quote for a roof repair', To: '+18175550100', From: '+12125550124' });
    checkIncludes('business speech goes to capture', r.body, '<Record');
    checkIncludes('business capture asks for job details', r.body, 'about the job');
    check('business log stays sort_business', deps._logs.at(-1).route_taken, 'sort_business');

    // Answered ring-through ends quietly.
    r = await post(`/api/phone/dial-status?log=${bizLogId}`, { DialCallStatus: 'completed' });
    check('completed dial returns an empty Response', r.body.includes('<Record'), false);

    // --- Ring-through toggle: unknown caller rings the owner ------------------
    deps._settings.ringThroughUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    r = await post('/api/phone/voice', { From: '+12125550125', To: '+18175550100' });
    checkIncludes('toggle on: stranger rings the owner too', r.body, '<Dial');
    check('toggle call logged as toggle_ringthrough', deps._logs.at(-1).route_taken, 'toggle_ringthrough');
    deps._settings.ringThroughUntil = null;

    // --- Disabled tenant: polite reject ---------------------------------------
    deps._settings.enabled = false;
    r = await post('/api/phone/voice', { From: '+18175550199', To: '+18175550100' });
    checkIncludes('disabled tenant gets the reject', r.body, 'this number is not in service');
    deps._settings.enabled = true;

    // --- Signature validation once the auth token is set ----------------------
    process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
    const voiceParams = { From: '+18175550199', To: '+18175550100', CallSid: 'CA123' };
    const voiceUrl = `${base}/api/phone/voice`;

    r = await post('/api/phone/voice', voiceParams, { 'x-twilio-signature': sign(voiceUrl, voiceParams, 'test-auth-token') });
    check('valid Twilio signature passes', r.status, 200);

    r = await post('/api/phone/voice', voiceParams, { 'x-twilio-signature': sign(voiceUrl, voiceParams, 'wrong-token') });
    check('tampered signature is 403', r.status, 403);

    r = await post('/api/phone/voice', voiceParams);
    check('missing signature is 403', r.status, 403);
  } finally {
    server.close();
    if (savedSid === undefined) delete process.env.TWILIO_ACCOUNT_SID; else process.env.TWILIO_ACCOUNT_SID = savedSid;
    if (savedToken === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = savedToken;
  }

  console.log(`\nAll ${passed} assertions passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
