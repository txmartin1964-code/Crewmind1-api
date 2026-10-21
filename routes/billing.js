/**
 * routes/billing.js
 * Owns: Tenant subscription billing endpoints.
 *   GET  /api/tenant/billing/status   — plan/trial/usage snapshot
 *   POST /api/tenant/billing/checkout — start a Core subscription checkout
 * Does NOT own: Stripe webhook handling (routes/payments.js), plan
 * policy (services/billing.js, services/usage.js).
 *
 * Mounted BEFORE the general /api/tenant router on purpose: a LOCKED
 * (trial-expired) tenant must still be able to pay. It uses requireTenant
 * for auth but deliberately skips blockWritesWhenLocked.
 */

const express = require('express');
const router = express.Router();

const { requireTenant } = require('../lib/auth');
const { effectiveStatus } = require('../db/tenants');
const billing = require('../services/billing');
const { getUsageSummary } = require('../services/usage');

router.use(requireTenant);

router.get('/status', async (req, res) => {
  try {
    const t = req.tenant;
    res.json({
      status: effectiveStatus(t),
      stored_status: t.status,
      is_comped: !!t.is_comped,
      comped_at: t.comped_at || null,
      plan: t.plan,
      billing_interval: t.billing_interval,
      founding_cohort: t.founding_cohort,
      cohort_number: t.cohort_number,
      trial_started_at: t.trial_started_at,
      trial_ends_at: t.trial_ends_at,
      subscription_status: t.subscription_status,
      current_period_end: t.current_period_end,
      billing_configured: billing.isBillingConfigured(),
      prices: {
        monthly_configured: !!process.env.STRIPE_PRICE_CORE_MONTHLY,
        annual_configured: !!process.env.STRIPE_PRICE_CORE_ANNUAL,
        founding_configured: !!process.env.STRIPE_PRICE_CORE_FOUNDING,
        founding_price_applies: !!(t.founding_cohort && process.env.STRIPE_PRICE_CORE_FOUNDING),
      },
      usage: await getUsageSummary(t),
    });
  } catch (err) {
    console.error('[billing] status error:', err);
    res.status(500).json({ error: 'Failed to load billing status.' });
  }
});

router.post('/checkout', async (req, res) => {
  try {
    // Lifetime comp (migration 012): a comped tenant never needs a Stripe
    // session. Answer politely instead of sending them to checkout.
    if (req.tenant.is_comped) {
      return res.json({
        comped: true,
        message: 'This account is on a lifetime comp — no payment needed. Enjoy CrewMind!',
      });
    }
    const interval = (req.body && req.body.interval === 'annual') ? 'annual' : 'monthly';
    if (!billing.isBillingConfigured()) {
      return res.status(503).json({
        error: 'Billing is not configured yet. CrewMind will contact you to activate your plan.',
        code: 'billing_not_configured',
      });
    }
    const session = await billing.createBillingCheckout(req.tenant, interval);
    if (!session) {
      return res.status(503).json({
        error: 'No price is configured for that billing interval.',
        code: 'price_not_configured',
      });
    }
    res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error('[billing] checkout error:', err);
    res.status(500).json({ error: 'Failed to start checkout.' });
  }
});

module.exports = router;
