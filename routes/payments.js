/**
 * routes/payments.js
 * Owns: HTTP handling for Stripe deposit payments — the customer-facing
 * pay link redirector and the Stripe webhook.
 * Does NOT own: session creation logic (services/payments.js), quote
 * writes (db/quotes.js).
 *
 * Mounting note (see server.js): the webhook handler is exported
 * separately and mounted with express.raw() BEFORE the global JSON parser
 * — Stripe signature verification needs the exact raw request body.
 */

const express = require('express');
const router = express.Router();

const { getQuoteById, markQuotePayment } = require('../db/quotes');
const { getLeadById } = require('../db/leads');
const {
  isStripeConfigured, getStripe, getBaseUrl, createOrReuseCheckoutSession,
} = require('../services/payments');

/**
 * GET /api/payments/link/:quoteId
 * Creates (or reuses) the quote's Stripe Checkout session and 302-redirects
 * the customer to Stripe. This stable URL is what goes in emails; the raw
 * Stripe session URL behind it expires after 24h.
 */
router.get('/link/:quoteId', async (req, res) => {
  try {
    if (!isStripeConfigured()) {
      return res.status(503).json({ error: 'Payments are not configured on this server yet.' });
    }

    const quote = await getQuoteById(req.params.quoteId);
    if (!quote) return res.status(404).json({ error: 'Quote not found.' });

    const lead = await getLeadById(quote.lead_id);
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });

    // Already paid — nothing to collect; send them to booking instead.
    if (quote.payment_status === 'deposit_paid' || quote.payment_status === 'paid') {
      return res.redirect(`${getBaseUrl()}/book?lead=${lead.id}&quote=${quote.id}&deposit=already_paid`);
    }

    const session = await createOrReuseCheckoutSession(lead, quote);
    if (!session || !session.url) {
      return res.status(400).json({ error: 'No payment is due for this quote.' });
    }

    return res.redirect(303, session.url);
  } catch (err) {
    console.error('[payments] link error:', err);
    return res.status(500).json({ error: 'Could not start payment. Please try again.' });
  }
});

/**
 * POST /api/payments/webhook  (mounted separately in server.js with raw body)
 * Verifies the Stripe signature and, on checkout.session.completed, marks
 * the quote paid. Signature failures return 400 so Stripe retries/alerts.
 */
async function webhookHandler(req, res) {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !webhookSecret) {
    console.error('[payments] webhook hit but Stripe is not fully configured (secret key and/or webhook secret missing).');
    return res.status(503).json({ error: 'Payments are not configured on this server yet.' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
  } catch (err) {
    console.error('[payments] webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const quoteId = parseInt(session.metadata?.quote_id || session.client_reference_id, 10);

      if (!quoteId) {
        console.error('[payments] checkout.session.completed without a quote_id — cannot apply payment. Session:', session.id);
      } else {
        const quote = await getQuoteById(quoteId);
        if (!quote) {
          console.error(`[payments] checkout.session.completed for unknown quote ${quoteId}. Session:`, session.id);
        } else if (quote.payment_status === 'deposit_paid' || quote.payment_status === 'paid') {
          console.log(`[payments] webhook for quote ${quoteId} already recorded (${quote.payment_status}) — ignoring duplicate.`);
        } else {
          const amountPaid = session.amount_total ?? 0;
          const paymentStatus = amountPaid >= (quote.total_cents || 0) ? 'paid' : 'deposit_paid';
          await markQuotePayment(quoteId, {
            paymentStatus,
            amountPaidCents: amountPaid,
            stripePaymentIntentId: typeof session.payment_intent === 'string'
              ? session.payment_intent
              : session.payment_intent?.id || null,
          });
          console.log(`[payments] quote ${quoteId} marked ${paymentStatus} ($${(amountPaid / 100).toFixed(2)}) via session ${session.id}.`);
        }
      }
    }
  } catch (err) {
    // The payment DID happen at Stripe; log loudly and still 200 so Stripe
    // does not retry forever — the state can be reconciled from the
    // Stripe dashboard, and the error is in the server log.
    console.error('[payments] webhook processing error:', err);
  }

  return res.json({ received: true });
}

module.exports = router;
module.exports.webhook = webhookHandler;
