/**
 * services/billing.js
 * Owns: Stripe SUBSCRIPTIONS for the CrewMind Core plan (tenant billing).
 * Does NOT own: job deposit payments (services/payments.js), tenant
 * records (db/tenants.js), webhook HTTP handling (routes/payments.js).
 *
 * Launch pricing (owner decision 2026-10-20): ONE tier, Core.
 *   - $149/mo billed monthly  -> STRIPE_PRICE_CORE_MONTHLY
 *   - $119/mo billed annually -> STRIPE_PRICE_CORE_ANNUAL
 *   - Founding cohort (first 100 tenants): $119/mo locked for 12 months
 *     -> STRIPE_PRICE_CORE_FOUNDING (used for founding tenants whenever
 *     configured; falls back to the interval price otherwise).
 *
 * Like Phase 1 payments, everything is inert without STRIPE_SECRET_KEY:
 * the app runs, signup/trial work, and billing endpoints answer 503.
 */

const { updateTenant } = require('../db/tenants');

let _stripe = null;
function stripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!_stripe) _stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

function isBillingConfigured() {
  return !!(stripeClient() && (
    process.env.STRIPE_PRICE_CORE_MONTHLY ||
    process.env.STRIPE_PRICE_CORE_ANNUAL ||
    process.env.STRIPE_PRICE_CORE_FOUNDING
  ));
}

function getPriceIdForTenant(tenant, interval) {
  if (tenant.founding_cohort && process.env.STRIPE_PRICE_CORE_FOUNDING) {
    return process.env.STRIPE_PRICE_CORE_FOUNDING;
  }
  if (interval === 'annual') return process.env.STRIPE_PRICE_CORE_ANNUAL || null;
  return process.env.STRIPE_PRICE_CORE_MONTHLY || null;
}

async function ensureStripeCustomer(tenant) {
  const stripe = stripeClient();
  if (!stripe) return null;
  if (tenant.stripe_customer_id) return tenant.stripe_customer_id;
  const customer = await stripe.customers.create({
    email: tenant.email,
    name: tenant.business_name,
    metadata: { tenant_id: String(tenant.id) },
  });
  await updateTenant(tenant.id, { stripe_customer_id: customer.id });
  return customer.id;
}

/** Creates a subscription Checkout session for upgrading/renewing Core. */
async function createBillingCheckout(tenant, interval) {
  const stripe = stripeClient();
  if (!stripe) return null;
  const price = getPriceIdForTenant(tenant, interval);
  if (!price) return null;

  const customerId = await ensureStripeCustomer(tenant);
  const appUrl = process.env.APP_URL || 'http://localhost:3000';

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    metadata: { tenant_id: String(tenant.id), billing_interval: interval },
    subscription_data: { metadata: { tenant_id: String(tenant.id) } },
    success_url: `${appUrl}/app.html?billing=success`,
    cancel_url: `${appUrl}/app.html?billing=cancelled`,
  });

  await updateTenant(tenant.id, { billing_interval: interval });
  return session;
}

/**
 * Maps a Stripe subscription object onto the tenant's status:
 *   active/trialing -> 'active'      past_due -> 'past_due'
 *   canceled/unpaid/incomplete_expired -> 'locked'
 *   incomplete (checkout abandoned mid-payment) -> status unchanged; a
 *   trialing tenant must never be locked for abandoning checkout.
 */
function mapSubscriptionStatus(subStatus) {
  switch (subStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'canceled':
    case 'unpaid':
    case 'incomplete_expired':
      return 'locked';
    default:
      return null; // leave tenant status alone
  }
}

async function applySubscriptionState(tenant, sub) {
  if (!tenant || !sub) return;
  const fields = {
    stripe_subscription_id: sub.id,
    subscription_status: sub.status,
  };
  if (sub.customer) fields.stripe_customer_id = sub.customer;
  if (sub.current_period_end) {
    fields.current_period_end = new Date(sub.current_period_end * 1000).toISOString();
  }
  const mapped = mapSubscriptionStatus(sub.status);
  // Lifetime comp (migration 012): Stripe bookkeeping (ids, subscription
  // status, period end) is still recorded, but a subscription event must
  // never move a comped tenant's status — the comp overlays billing, so
  // a stray past_due/canceled event cannot lock them.
  if (mapped && !tenant.is_comped) fields.status = mapped;
  await updateTenant(tenant.id, fields);
}

async function retrieveSubscription(subscriptionId) {
  const stripe = stripeClient();
  if (!stripe) return null;
  return stripe.subscriptions.retrieve(subscriptionId);
}

module.exports = {
  isBillingConfigured,
  getPriceIdForTenant,
  ensureStripeCustomer,
  createBillingCheckout,
  mapSubscriptionStatus,
  applySubscriptionState,
  retrieveSubscription,
};
