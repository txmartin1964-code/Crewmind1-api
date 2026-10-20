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
const { getInvoiceById, markInvoicePaid } = require('../db/invoices');
const { updateJobStatus, logJobEvent } = require('../db/jobs');
const invoicing = require('../services/invoicing');
const { getLeadById } = require('../db/leads');
const {
  getTenantById, getTenantByStripeCustomerId, getTenantBySubscriptionId, updateTenant,
} = require('../db/tenants');
const {
  isStripeConfigured, getStripe, getBaseUrl, createOrReuseCheckoutSession,
} = require('../services/payments');
const billing = require('../services/billing');

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
 * GET /api/payments/invoice-link/:invoiceId
 * Same stable-redirector pattern as quote deposits, for final invoices.
 */
router.get('/invoice-link/:invoiceId', async (req, res) => {
  try {
    if (!isStripeConfigured()) {
      return res.status(503).json({ error: 'Payments are not configured on this server yet.' });
    }
    const invoice = await getInvoiceById(req.params.invoiceId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
    if (invoice.status === 'paid') {
      return res.redirect(`${getBaseUrl()}/invoice-paid.html?invoice=${encodeURIComponent(invoice.invoice_number || invoice.id)}`);
    }
    if (!invoice.job_id) return res.status(400).json({ error: 'Invoice is not attached to a job.' });
    const job = await require('../db/jobs').getJobById(invoice.job_id);
    const lead = job && job.lead_id ? await getLeadById(job.lead_id) : null;
    const session = await invoicing.createOrReuseInvoiceSession(lead, invoice);
    if (!session || !session.url) {
      return res.status(400).json({ error: 'No payment is due for this invoice.' });
    }
    return res.redirect(303, session.url);
  } catch (err) {
    console.error('[payments] invoice link error:', err);
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
    // ---- Subscription (tenant billing) events — Phase 2 ----
    if (event.type === 'checkout.session.completed' && event.data.object.mode === 'subscription') {
      const session = event.data.object;
      const tenantId = parseInt(session.metadata?.tenant_id, 10);
      const tenant = Number.isNaN(tenantId) ? null : await getTenantById(tenantId);
      if (!tenant) {
        console.error('[billing] subscription checkout completed without a resolvable tenant. Session:', session.id);
      } else {
        await updateTenant(tenant.id, {
          stripe_customer_id: session.customer || tenant.stripe_customer_id,
          stripe_subscription_id: session.subscription || tenant.stripe_subscription_id,
        });
        if (session.subscription) {
          const sub = await billing.retrieveSubscription(session.subscription);
          if (sub) await billing.applySubscriptionState(tenant, sub);
        }
        console.log(`[billing] tenant ${tenant.id} subscription checkout completed (session ${session.id}).`);
      }
      return res.json({ received: true });
    }

    if (event.type === 'customer.subscription.created' ||
        event.type === 'customer.subscription.updated' ||
        event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      let tenant = null;
      const metaTenantId = parseInt(sub.metadata?.tenant_id, 10);
      if (!Number.isNaN(metaTenantId)) tenant = await getTenantById(metaTenantId);
      if (!tenant) tenant = await getTenantBySubscriptionId(sub.id);
      if (!tenant && sub.customer) tenant = await getTenantByStripeCustomerId(sub.customer);
      if (!tenant) {
        console.error('[billing] subscription event for unknown tenant. Subscription:', sub.id);
      } else if (event.type === 'customer.subscription.deleted') {
        await updateTenant(tenant.id, { status: 'locked', subscription_status: 'canceled' });
        console.log(`[billing] tenant ${tenant.id} subscription canceled — account locked.`);
      } else {
        await billing.applySubscriptionState(tenant, sub);
        console.log(`[billing] tenant ${tenant.id} subscription ${sub.id} -> ${sub.status}.`);
      }
      return res.json({ received: true });
    }

    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const tenant = invoice.customer ? await getTenantByStripeCustomerId(invoice.customer) : null;
      if (tenant) {
        await updateTenant(tenant.id, { status: 'past_due', subscription_status: 'past_due' });
        console.log(`[billing] tenant ${tenant.id} payment failed — marked past_due.`);
      }
      return res.json({ received: true });
    }

    if (event.type === 'checkout.session.completed' && event.data.object.metadata?.invoice_id) {
      const session = event.data.object;
      const invoiceId = parseInt(session.metadata.invoice_id, 10);
      const invoice = await getInvoiceById(invoiceId);
      if (!invoice) {
        console.error('[payments] invoice checkout completed for unknown invoice', invoiceId);
      } else if (invoice.status === 'paid') {
        console.log(`[payments] invoice ${invoiceId} already paid — ignoring duplicate webhook.`);
      } else {
        await markInvoicePaid(invoiceId, {
          amountPaidCents: session.amount_total ?? invoice.amount_due_cents,
          stripePaymentIntentId: typeof session.payment_intent === 'string'
            ? session.payment_intent
            : session.payment_intent?.id || null,
        });
        if (invoice.job_id) {
          await updateJobStatus(invoice.job_id, 'paid');
          await logJobEvent(invoice.job_id, invoice.tenant_id, 'invoice_paid', {
            invoice_id: invoiceId, amount_cents: session.amount_total ?? null,
          });
        }
        console.log(`[payments] invoice ${invoiceId} marked paid via session ${session.id}.`);
      }
      return res.json({ received: true });
    }

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
