/**
 * routes/onboarding.js
 * Owns: The ≤15-minute onboarding wizard API.
 *   GET  /api/onboarding/prefill?name=&city=  — best-effort public-data
 *        prefill (never blocks; { found:false } on any failure).
 *   GET  /api/onboarding/status               — progress + quote URL.
 *   POST /api/onboarding/complete             — save wizard answers,
 *        mark onboarding complete, tenant quote page goes live.
 * Does NOT own: signup (routes/signup.js), console settings
 * (routes/tenant.js) — onboarding writes through the same per-tenant
 * settings store.
 *
 * Product requirement: a buyer goes from signup to a live quote page in
 * under 15 minutes. Everything here is one short form: business lookup
 * prefill, trade, notifications, service area, hours, and a SKIPPABLE
 * payout step (skipping sets payout_skipped — the console keeps a
 * reminder up until payouts are connected).
 */

const express = require('express');
const router = express.Router();

const { requireTenant, blockWritesWhenLocked } = require('../lib/auth');
const { publicTenant, updateTenant } = require('../db/tenants');
const { getSetting, setSetting } = require('../db/settings');
const { seedPricingRulesForTenant } = require('../db/quotes');
const { ensureUpcomingSlots } = require('../db/appointments');
const { getBusinessPrefill } = require('../services/prefill');

const TRADES = [
  'roofing', 'plumbing', 'hvac', 'electrical', 'concrete', 'drywall',
  'landscaping', 'painting', 'remodeling', 'flooring', 'handyman', 'other',
];

router.use(requireTenant);
router.use(blockWritesWhenLocked);

router.get('/prefill', async (req, res) => {
  const name = (req.query.name || req.tenant.business_name || '').toString();
  const city = (req.query.city || '').toString();
  const result = await getBusinessPrefill(name, city);
  res.json(result);
});

router.get('/status', async (req, res) => {
  const t = req.tenant;
  res.json({
    completed: !!t.onboarding_completed_at,
    onboarding_completed_at: t.onboarding_completed_at,
    payout_connected: t.payout_connected,
    payout_skipped: t.payout_skipped,
    quote_url: `/q/${t.slug}`,
    trade: await getSetting('trade', null, t.id),
  });
});

router.post('/complete', async (req, res) => {
  try {
    const t = req.tenant;
    const body = req.body || {};

    const trade = body.trade ? String(body.trade).toLowerCase() : null;
    if (trade && !TRADES.includes(trade)) {
      return res.status(400).json({ error: `Unknown trade. Choose one of: ${TRADES.join(', ')}.` });
    }

    // The trade loads the tenant's default price book (Phase 1 seed).
    // Idempotent — signup already seeded it; this also repairs tenants
    // created before seeding existed.
    await seedPricingRulesForTenant(t.id);
    if (trade) await setSetting('trade', trade, t.id);

    const settingsToSave = {
      notification_email: body.notification_email,
      notification_phone: body.notification_phone,
      service_area: body.service_area,
      business_hours: body.business_hours,
      business_address: body.business_address,
      business_phone: body.business_phone,
      website: body.website,
      google_place_id: body.google_place_id,
    };
    for (const [key, value] of Object.entries(settingsToSave)) {
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        await setSetting(key, String(value).trim(), t.id);
      }
    }

    // Payout step: connect is offered, skipping is one click. There is
    // no fake OAuth here — until per-tenant Stripe Connect ships,
    // deposits settle through the platform account and every payment is
    // recorded against the tenant's own jobs. Skipping (or deferring)
    // sets the reminder flag the console nags about.
    let payoutNote;
    if (body.payout === 'connect') {
      payoutNote = 'Payout setup noted. Deposits currently settle through CrewMind and are recorded per job on your account; per-tenant payout connection completes from your console.';
      await updateTenant(t.id, { payout_skipped: true });
    } else {
      payoutNote = 'Payouts skipped for now — you can connect them any time from your console. Deposits still work; they settle through CrewMind meanwhile.';
      await updateTenant(t.id, { payout_skipped: true });
    }

    await ensureUpcomingSlots({ tenantId: t.id }).catch(() => {});

    const updated = await updateTenant(t.id, { onboarding_completed_at: new Date().toISOString() });
    res.json({
      ok: true,
      quote_url: `/q/${t.slug}`,
      payout_note: payoutNote,
      tenant: publicTenant(updated),
    });
  } catch (err) {
    console.error('[onboarding] complete error:', err);
    res.status(500).json({ error: 'Failed to finish onboarding.' });
  }
});

module.exports = router;
