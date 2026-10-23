/**
 * routes/phone.js
 * Owns: Twilio voice webhooks for the Phase 10 phone module —
 * inbound routing, the conversational sort, the ring-through
 * no-answer cascade, and recording/transcription capture.
 * Does NOT own: routing decisions (lib/phone-routing.js),
 * persistence (db/phone.js), telephony config (env vars below).
 *
 * Hand-rolled TwiML on purpose: no twilio npm package, dependencies
 * unchanged. Signature validation is hand-rolled HMAC-SHA1 per
 * Twilio's published algorithm.
 *
 * INERT BY DEFAULT: unless TWILIO_ACCOUNT_SID is set, every endpoint
 * returns 503 and nothing else in the app changes. When
 * TWILIO_AUTH_TOKEN is also set, requests must carry a valid
 * X-Twilio-Signature; with the token unset, validation is skipped
 * (local dev mode).
 *
 * Call flow (see crewmind-notes/phone-module-personal-call-routing.md):
 *   POST /voice        → toggle/whitelist: <Dial> the owner.
 *                        unknown caller: AI-honest greeting + <Gather> sort.
 *   POST /sort         → "personal"/2: <Dial> the owner (route sort_personal).
 *                        anything else: business message capture.
 *   POST /dial-status  → owner didn't answer a ring-through: cascade
 *                        to message capture (route becomes 'capture').
 *   POST /recording    → <Record> action (saves recording_url, replies
 *                        thanks/goodbye) AND transcribeCallback (saves
 *                        transcription) — one endpoint, told apart by
 *                        which fields Twilio posts.
 * The call_log row is created at /voice and its id rides in every
 * action URL (?log=<id>) so later callbacks update the same row.
 */

const express = require('express');
const crypto = require('crypto');
const dbPhone = require('../db/phone');
const { normalizePhone, decideRoute, isPersonalSort } = require('../lib/phone-routing');

const BUSINESS_CAPTURE_INTRO = "Thanks. Please leave your name, a callback number, and a few details about the job after the tone, and we'll get right back to you.";
const PERSONAL_CAPTURE_INTRO = "Sorry, they can't come to the phone right now. Please leave a message after the tone, and it will be passed along.";

// -- TwiML helpers ------------------------------------------------------------

const xmlEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function sendTwiml(res, body) {
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
}

const rejectBody = () => `<Say>Sorry, this number is not in service.</Say><Hangup/>`;

const dialBody = (ownerE164, logId) =>
  `<Dial action="/api/phone/dial-status?log=${logId}" method="POST" timeout="20"><Number>${xmlEsc(ownerE164)}</Number></Dial>`;

const sortBody = (greetingName, logId) =>
  `<Gather input="speech dtmf" numDigits="1" timeout="5" speechTimeout="auto" action="/api/phone/sort?log=${logId}" method="POST">` +
  `<Say>Thanks for calling ${xmlEsc(greetingName)}. This is the virtual assistant. I can help with jobs right now. ` +
  `If this is a personal call, say personal, or press 2, and I'll put you straight through.</Say></Gather>` +
  `<Redirect method="POST">/api/phone/sort?log=${logId}</Redirect>`;

const captureBody = (intro, logId) =>
  `<Say>${xmlEsc(intro)}</Say>` +
  `<Record action="/api/phone/recording?log=${logId}" method="POST" maxLength="120" playBeep="true" ` +
  `transcribe="true" transcribeCallback="/api/phone/recording?log=${logId}"/>` +
  `<Say>We didn't get a message. Goodbye.</Say><Hangup/>`;

// -- Twilio request gate --------------------------------------------------------

function requireTwilioConfigured(req, res, next) {
  if (!process.env.TWILIO_ACCOUNT_SID) {
    return res.status(503).type('text/plain')
      .send('Phone module is not configured on this server (Twilio credentials are not set).');
  }
  next();
}

/** Twilio's signature: HMAC-SHA1(authToken, url + sorted key/value pairs), base64. */
function isValidTwilioSignature(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return true; // dev mode — no token, no validation
  const signature = req.headers['x-twilio-signature'];
  if (!signature) return false;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  let data = `${proto}://${req.headers.host}${req.originalUrl}`;
  const params = req.body || {};
  for (const key of Object.keys(params).sort()) data += key + String(params[key]);
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireValidSignature(req, res, next) {
  if (!isValidTwilioSignature(req)) {
    return res.status(403).type('text/plain').send('Invalid Twilio signature.');
  }
  next();
}

// -- Handlers (deps injectable for tests) ---------------------------------------

const defaultDeps = {
  findTenantByDialedNumber: dbPhone.findTenantByDialedNumber,
  getPhoneSettings: dbPhone.getPhoneSettings,
  isPersonalContact: dbPhone.isPersonalContact,
  createCallLog: dbPhone.createCallLog,
  getCallLog: dbPhone.getCallLog,
  updateCallLog: dbPhone.updateCallLog,
};

async function resolveLogAndTenant(req, deps) {
  const logId = parseInt(req.query.log, 10);
  if (!Number.isNaN(logId)) {
    const log = await deps.getCallLog(logId);
    if (log) return { log, tenantId: log.tenant_id };
  }
  // No (valid) log id — resolve from the dialed number and start a row.
  const tenantId = await deps.findTenantByDialedNumber(normalizePhone(req.body.To));
  if (!tenantId) return { log: null, tenantId: null };
  const log = await deps.createCallLog(tenantId, {
    fromNumber: normalizePhone(req.body.From),
    routeTaken: 'sort_business',
  });
  return { log, tenantId };
}

function createPhoneRouter(deps = defaultDeps) {
  const router = express.Router();
  router.use(requireTwilioConfigured);
  router.use(requireValidSignature);

  async function handleVoice(req, res) {
    try {
      const from = normalizePhone(req.body.From);
      const tenantId = await deps.findTenantByDialedNumber(normalizePhone(req.body.To));
      if (!tenantId) return sendTwiml(res, rejectBody());

      const settings = await deps.getPhoneSettings(tenantId);
      if (!settings.enabled) return sendTwiml(res, rejectBody());

      const whitelistMatch = from ? await deps.isPersonalContact(tenantId, from) : false;
      const decision = decideRoute({ callerNumber: from, settings, whitelistMatch, now: new Date() });

      if (decision.action === 'ring_owner') {
        const log = await deps.createCallLog(tenantId, { fromNumber: from, routeTaken: decision.route });
        return sendTwiml(res, dialBody(normalizePhone(settings.ownerNumber), log.id));
      }

      // Sort path: provisional business route — /sort corrects it to
      // sort_personal when the caller asks for the owner.
      const log = await deps.createCallLog(tenantId, { fromNumber: from, routeTaken: 'sort_business' });
      return sendTwiml(res, sortBody(settings.greetingName || 'this business', log.id));
    } catch (err) {
      console.error('[phone] voice error:', err);
      return sendTwiml(res, `<Say>Sorry, something went wrong. Please try again later.</Say><Hangup/>`);
    }
  }

  async function handleSort(req, res) {
    try {
      const { log, tenantId } = await resolveLogAndTenant(req, deps);
      if (!log) return sendTwiml(res, rejectBody());
      const settings = await deps.getPhoneSettings(tenantId);

      if (isPersonalSort({ speechResult: req.body.SpeechResult, digits: req.body.Digits })) {
        await deps.updateCallLog(log.id, { routeTaken: 'sort_personal' });
        const owner = normalizePhone(settings.ownerNumber);
        if (owner) return sendTwiml(res, dialBody(owner, log.id));
        // Personal caller but no owner number on file — capture beats a dead end.
        return sendTwiml(res, captureBody(PERSONAL_CAPTURE_INTRO, log.id));
      }

      await deps.updateCallLog(log.id, { routeTaken: 'sort_business' });
      return sendTwiml(res, captureBody(BUSINESS_CAPTURE_INTRO, log.id));
    } catch (err) {
      console.error('[phone] sort error:', err);
      return sendTwiml(res, `<Say>Sorry, something went wrong. Please try again later.</Say><Hangup/>`);
    }
  }

  async function handleDialStatus(req, res) {
    try {
      if (req.body.DialCallStatus === 'completed') return sendTwiml(res, '');
      const logId = parseInt(req.query.log, 10);
      const log = Number.isNaN(logId) ? null : await deps.getCallLog(logId);
      if (!log) return sendTwiml(res, '');
      // No answer / busy / failed: a personal call is never just lost —
      // it cascades to message capture.
      await deps.updateCallLog(log.id, { routeTaken: 'capture' });
      return sendTwiml(res, captureBody(PERSONAL_CAPTURE_INTRO, log.id));
    } catch (err) {
      console.error('[phone] dial-status error:', err);
      return sendTwiml(res, '');
    }
  }

  async function handleRecording(req, res) {
    try {
      const logId = parseInt(req.query.log, 10);
      const log = Number.isNaN(logId) ? null : await deps.getCallLog(logId);

      // Transcription delivery (transcribeCallback): save the text, no TwiML.
      if (req.body.TranscriptionText !== undefined || req.body.TranscriptionStatus !== undefined) {
        if (log && req.body.TranscriptionText) {
          await deps.updateCallLog(log.id, { transcription: req.body.TranscriptionText });
        }
        return res.status(200).type('text/plain').send('');
      }

      // Recording action: save the URL, thank the caller, hang up.
      if (log && req.body.RecordingUrl) {
        await deps.updateCallLog(log.id, { recordingUrl: req.body.RecordingUrl });
      }
      return sendTwiml(res, `<Say>Thanks — we've got your message. Goodbye.</Say><Hangup/>`);
    } catch (err) {
      console.error('[phone] recording error:', err);
      return sendTwiml(res, `<Hangup/>`);
    }
  }

  // GET /voice exists so a plain browser/deploy check sees the inert
  // 503 (or the live handler) instead of a misleading 404. Twilio
  // itself always POSTs.
  router.get('/voice', handleVoice);
  router.post('/voice', handleVoice);
  router.post('/sort', handleSort);
  router.post('/dial-status', handleDialStatus);
  router.post('/recording', handleRecording);

  return router;
}

module.exports = createPhoneRouter();
module.exports.createPhoneRouter = createPhoneRouter;
module.exports.isValidTwilioSignature = isValidTwilioSignature;
