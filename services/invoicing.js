/**
 * services/invoicing.js
 * Owns: Final-invoice math and Stripe checkout for invoices.
 * Does NOT own: invoice storage (db/invoices.js), job records
 * (db/jobs.js), deposit sessions (services/payments.js).
 *
 * The final invoice is the BALANCE on a job:
 *   amount due = quote total + approved change orders − deposit paid.
 * Draft invoices recompute at send time, so a change order approved
 * after the draft was created still lands on the bill. Payments ride
 * the same stable-redirector pattern as deposits: emailed links point
 * at /api/payments/invoice-link/:id, which reuses or recreates the
 * underlying (24h-expiring) Stripe session at click time.
 */

const { getQuoteById } = require('../db/quotes');
const { getJobById, logJobEvent } = require('../db/jobs');
const {
  createInvoice, getInvoiceById, getFinalInvoiceForJob, updateInvoice,
} = require('../db/invoices');
const { getStripe, getBaseUrl, isStripeConfigured } = require('./payments');

const SESSION_REUSE_WINDOW_MS = 60 * 1000;

/** Money snapshot for a job: quote total + APPROVED change orders. */
async function getJobFinancials(job) {
  const quote = job.quote_id ? await getQuoteById(job.quote_id) : null;
  const quoteTotal = quote ? (quote.total_cents || 0) : 0;
  const depositPaid = quote && (quote.payment_status === 'deposit_paid' || quote.payment_status === 'paid')
    ? (quote.amount_paid_cents || 0)
    : 0;
  const { sumApprovedChangeOrders } = require('../db/change-orders');
  const changeOrdersCents = await sumApprovedChangeOrders(job.id);
  const jobTotal = quoteTotal + changeOrdersCents;
  return {
    quote,
    quote_total_cents: quoteTotal,
    deposit_paid_cents: depositPaid,
    change_orders_cents: changeOrdersCents,
    job_total_cents: jobTotal,
    balance_cents: Math.max(0, jobTotal - depositPaid),
  };
}

/** Create the job's final invoice, or refresh a not-yet-paid one. */
async function createOrRefreshFinalInvoice(job) {
  const fin = await getJobFinancials(job);
  const existing = await getFinalInvoiceForJob(job.id);
  const amounts = {
    total_cents: fin.job_total_cents,
    deposit_paid_cents: fin.deposit_paid_cents,
    change_orders_cents: fin.change_orders_cents,
    amount_due_cents: fin.balance_cents,
  };
  if (existing) {
    if (existing.status === 'paid' || existing.status === 'void') return existing;
    return updateInvoice(existing.id, amounts);
  }
  const invoice = await createInvoice({
    tenant_id: job.tenant_id,
    job_id: job.id,
    quote_id: job.quote_id,
    kind: 'final',
    ...amounts,
  });
  await logJobEvent(job.id, job.tenant_id, 'invoice_created', {
    invoice_id: invoice.id, invoice_number: invoice.invoice_number, amount_due_cents: invoice.amount_due_cents,
  });
  return invoice;
}

function getInvoicePayLinkUrl(invoiceId) {
  return `${getBaseUrl()}/api/payments/invoice-link/${invoiceId}`;
}

async function createOrReuseInvoiceSession(lead, invoice) {
  const stripe = getStripe();
  if (!stripe || !invoice || invoice.amount_due_cents <= 0) return null;

  if (invoice.stripe_session_id) {
    try {
      const existing = await stripe.checkout.sessions.retrieve(invoice.stripe_session_id);
      const reusable = existing &&
        (existing.status === 'open' || existing.status === 'complete') &&
        existing.expires_at * 1000 > Date.now() + SESSION_REUSE_WINDOW_MS;
      if (reusable) {
        if (existing.status === 'open') return existing;
        const refreshed = await getInvoiceById(invoice.id);
        if (refreshed && refreshed.status === 'paid') return existing;
      }
    } catch (err) {
      console.error(`[invoicing] could not retrieve session ${invoice.stripe_session_id}:`, err.message);
    }
  }

  const baseUrl = getBaseUrl();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: lead && lead.email ? lead.email : undefined,
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: `Final invoice ${invoice.invoice_number || ''}`.trim(),
          description: 'Balance due for completed work',
        },
        unit_amount: invoice.amount_due_cents,
      },
      quantity: 1,
    }],
    metadata: {
      invoice_id: String(invoice.id),
      tenant_id: String(invoice.tenant_id),
      job_id: invoice.job_id ? String(invoice.job_id) : '',
    },
    success_url: `${baseUrl}/invoice-paid.html?invoice=${encodeURIComponent(invoice.invoice_number || invoice.id)}`,
    cancel_url: `${baseUrl}/invoice-paid.html?invoice=${encodeURIComponent(invoice.invoice_number || invoice.id)}&cancelled=1`,
  });

  await updateInvoice(invoice.id, { stripe_session_id: session.id });
  return session;
}

module.exports = {
  getJobFinancials,
  createOrRefreshFinalInvoice,
  getInvoicePayLinkUrl,
  createOrReuseInvoiceSession,
  isStripeConfigured,
};
