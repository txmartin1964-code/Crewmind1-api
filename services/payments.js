/**
 * services/payments.js
 *
 * Owns: Stripe Checkout integration for quote deposits.
 * Does NOT own: quote math (services/quote-engine.js), email delivery
 * (services/email.js), HTTP handling (routes/payments.js).
 *
 * Env:
 *   STRIPE_SECRET_KEY     - required to enable payments. When unset, every
 *                           payment feature no-ops cleanly (no sessions, no
 *                           pay links) and the rest of the app is unaffected.
 *   STRIPE_WEBHOOK_SECRET - required for the webhook to verify events.
 *
 * Deposit model: a single settings value, deposit_percent (default 20,
 * migration 003, editable in the admin console), applied to the quote
 * total. "Amount due now" for a quote = deposit_percent% of total_cents.
 */

const { getSetting } = require('../db/settings');
const { setQuoteCheckoutSession } = require('../db/quotes');

function isStripeConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

let stripeClient = null;
function getStripe() {
  if (!isStripeConfigured()) return null;
  if (!stripeClient) {
    // Required lazily so the app never depends on Stripe being present
    // (or configured) just to boot.
    const Stripe = require('stripe');
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

function getBaseUrl() {
  return (process.env.APP_URL || 'https://crewmind1-api.onrender.com').replace(/\/$/, '');
}

async function getDepositPercent(tenantId = 1) {
  const raw = await getSetting('deposit_percent', '20', tenantId);
  const pct = parseInt(raw, 10);
  if (Number.isNaN(pct)) return 20;
  return Math.min(100, Math.max(0, pct));
}

async function computeDepositCents(quote) {
  const pct = await getDepositPercent(quote.tenant_id || 1);
  return Math.round((quote.total_cents || 0) * pct / 100);
}

/**
 * Returns the canonical "pay deposit" URL for a quote: our own redirector
 * (/api/payments/link/:quoteId), which creates or reuses a live Stripe
 * Checkout session at click time. We email this stable URL rather than a
 * raw Stripe session URL because Stripe session URLs expire after 24h and
 * quote emails are often opened days later.
 */
function getPaymentLinkUrl(quoteId) {
  return `${getBaseUrl()}/api/payments/link/${quoteId}`;
}

/**
 * Creates a Stripe Checkout session for the quote's deposit, or reuses the
 * stored session if it is still open. Stores the session id on the quote.
 * Returns the session, or null when payments are unconfigured or the
 * amount due is zero.
 */
async function createOrReuseCheckoutSession(lead, quote) {
  const stripe = getStripe();
  if (!stripe) return null;
  if (quote.payment_status && quote.payment_status !== 'unpaid') return null;

  const amountDue = await computeDepositCents(quote);
  if (!amountDue || amountDue <= 0) return null;

  // Reuse a still-open session instead of minting duplicates.
  if (quote.stripe_checkout_session_id) {
    try {
      const existing = await stripe.checkout.sessions.retrieve(quote.stripe_checkout_session_id);
      if (existing && existing.status === 'open') return existing;
    } catch (err) {
      console.warn('[payments] could not retrieve stored checkout session, creating a new one:', err.message);
    }
  }

  const jobLabel = (quote.job_type || lead.job_type || 'service').replace(/_/g, ' ');
  const isFullPayment = amountDue >= (quote.total_cents || 0);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: isFullPayment
            ? `Payment — ${jobLabel} (Quote #${quote.id})`
            : `Deposit — ${jobLabel} (Quote #${quote.id})`,
          description: isFullPayment
            ? 'Full payment for your estimate. Thank you!'
            : 'Deposit toward your estimate. The balance is due on completion.',
        },
        unit_amount: amountDue,
      },
      quantity: 1,
    }],
    customer_email: lead.email || undefined,
    client_reference_id: String(quote.id),
    metadata: { lead_id: String(lead.id), quote_id: String(quote.id) },
    payment_intent_data: {
      metadata: { lead_id: String(lead.id), quote_id: String(quote.id) },
    },
    success_url: `${getBaseUrl()}/book?lead=${lead.id}&quote=${quote.id}&deposit=paid`,
    cancel_url: `${getBaseUrl()}/book?lead=${lead.id}&quote=${quote.id}&deposit=cancelled`,
  });

  await setQuoteCheckoutSession(quote.id, session.id);
  return session;
}

module.exports = {
  isStripeConfigured,
  getStripe,
  getBaseUrl,
  getDepositPercent,
  computeDepositCents,
  getPaymentLinkUrl,
  createOrReuseCheckoutSession,
};
