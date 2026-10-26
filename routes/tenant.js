/**
 * routes/tenant.js
 * Owns: The tenant console API — everything a subscribing business sees
 * and does after signing in. Mounted at /api/tenant behind requireTenant
 * (JWT session). Every query is scoped to req.tenantId; a tenant can
 * never read or write another tenant's rows.
 * Does NOT own: auth mechanics (lib/auth.js), billing checkout
 * (routes/billing.js), onboarding (routes/onboarding.js).
 *
 * Lock rule: reads always work; writes are blocked with 402 while the
 * tenant is locked (trial expired / subscription inactive) so the
 * console doubles as the upgrade prompt.
 */

const express = require('express');
const router = express.Router();

const { requireTenant, blockWritesWhenLocked } = require('../lib/auth');
const { publicTenant } = require('../db/tenants');
const { getLeads, countLeads } = require('../db/leads');
const { getPricingRules, updatePricingRule } = require('../db/quotes');
const { getUpcomingAppointments } = require('../db/appointments');
const { getContracts } = require('../db/contracts');
const { getAllSettings, setSetting } = require('../db/settings');
const { checkCap, getUsageSummary } = require('../services/usage');
const { recordUsage } = require('../db/usage');
const { saveScrapedLeads, getScrapedLeadsByTenant } = require('../db/scraped-leads');
const { getLeadById } = require('../db/leads');
const { getQuoteByLeadId, getQuoteById } = require('../db/quotes');
const jobsDb = require('../db/jobs');
const invoicesDb = require('../db/invoices');
const invoicing = require('../services/invoicing');
const { sendFinalInvoice } = require('../services/email');
const { getAllSettings: getAllSettingsDb } = require('../db/settings');

router.use(requireTenant);
router.use(blockWritesWhenLocked);

/** GET /api/tenant/me — the signed-in business + status summary. */
router.get('/me', async (req, res) => {
  try {
    const counts = await countLeads(req.tenantId);
    res.json({ tenant: publicTenant(req.tenant), lead_counts: counts });
  } catch (err) {
    console.error('[tenant] me error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/tenant/leads?status=&limit= — this tenant's leads only. */
router.get('/leads', async (req, res) => {
  try {
    const leads = await getLeads({
      tenantId: req.tenantId,
      status: req.query.status || undefined,
      limit: parseInt(req.query.limit, 10) || 50,
    });
    res.json({ leads });
  } catch (err) {
    console.error('[tenant] leads error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/tenant/appointments — this tenant's upcoming appointments. */
router.get('/appointments', async (req, res) => {
  try {
    const appointments = await getUpcomingAppointments(req.tenantId);
    res.json({ appointments });
  } catch (err) {
    console.error('[tenant] appointments error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/tenant/contracts — this tenant's contracts. */
router.get('/contracts', async (req, res) => {
  try {
    const contracts = await getContracts({ tenantId: req.tenantId, limit: parseInt(req.query.limit, 10) || 100 });
    res.json({ contracts });
  } catch (err) {
    console.error('[tenant] contracts error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/tenant/pricing — this tenant's own price book. */
router.get('/pricing', async (req, res) => {
  try {
    const rules = await getPricingRules(req.tenantId);
    res.json({ rules });
  } catch (err) {
    console.error('[tenant] pricing error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** PATCH /api/tenant/pricing/:id — update one of this tenant's rules. */
router.patch('/pricing/:id', async (req, res) => {
  try {
    const { base_price_cents, price_per_sqft_cents, notes } = req.body || {};
    const rule = await updatePricingRule(req.params.id, { base_price_cents, price_per_sqft_cents, notes }, req.tenantId);
    if (!rule) return res.status(404).json({ error: 'Pricing rule not found.' });
    res.json({ rule });
  } catch (err) {
    console.error('[tenant] pricing update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Settings a tenant may read/write in the console. deposit_percent and
// the business identity mirror the operator console; google_review_url
// powers the review bot; overage_* control the qualified-lead cap.
const TENANT_SETTINGS = [
  'deposit_percent', 'business_name', 'business_address', 'business_phone',
  'notification_email', 'notification_phone', 'service_area', 'business_hours',
  'google_review_url', 'overage_enabled', 'overage_cap_leads',
  'qbo_realm_id', 'qbo_connected',
];

router.get('/settings', async (req, res) => {
  try {
    const raw = await getAllSettings(req.tenantId);
    const settings = {};
    for (const key of TENANT_SETTINGS) settings[key] = raw[key] ?? null;
    res.json({ settings });
  } catch (err) {
    console.error('[tenant] settings read error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/settings', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.deposit_percent !== undefined) {
      const pct = parseInt(body.deposit_percent, 10);
      if (Number.isNaN(pct) || pct < 0 || pct > 100) {
        return res.status(400).json({ error: 'deposit_percent must be an integer between 0 and 100.' });
      }
    }
    if (body.overage_cap_leads !== undefined) {
      const cap = parseInt(body.overage_cap_leads, 10);
      if (Number.isNaN(cap) || cap < 0 || cap > 100000) {
        return res.status(400).json({ error: 'overage_cap_leads must be a non-negative integer.' });
      }
    }
    for (const key of TENANT_SETTINGS) {
      if (body[key] !== undefined) await setSetting(key, String(body[key]), req.tenantId);
    }
    const raw = await getAllSettings(req.tenantId);
    const settings = {};
    for (const key of TENANT_SETTINGS) settings[key] = raw[key] ?? null;
    res.json({ settings });
  } catch (err) {
    console.error('[tenant] settings update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------------- Jobs & final invoices (Item 4) ---------------- */

/** GET /api/tenant/jobs — this tenant's jobs with customer + quote info. */
router.get('/jobs', async (req, res) => {
  try {
    const jobs = await jobsDb.getJobs({ tenantId: req.tenantId });
    res.json({ jobs });
  } catch (err) {
    console.error('[tenant] jobs error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/tenant/jobs — create a job from one of this tenant's leads/quotes. */
router.post('/jobs', async (req, res) => {
  try {
    const { lead_id, quote_id, title } = req.body || {};
    if (!lead_id && !quote_id) {
      return res.status(400).json({ error: 'lead_id or quote_id is required.' });
    }
    let lead = null;
    let quote = null;
    if (quote_id) {
      quote = await getQuoteById(quote_id);
      if (!quote || quote.tenant_id !== req.tenantId) return res.status(404).json({ error: 'Quote not found.' });
    }
    if (lead_id) {
      lead = await getLeadById(lead_id);
      if (!lead || lead.tenant_id !== req.tenantId) return res.status(404).json({ error: 'Lead not found.' });
    }
    if (!lead && quote) lead = await getLeadById(quote.lead_id);
    if (!quote && lead) quote = await getQuoteByLeadId(lead.id);
    if (quote) {
      const existing = await jobsDb.getJobByQuoteId(quote.id);
      if (existing) return res.json({ job: existing, existed: true });
    }
    const job = await jobsDb.createJob({
      tenant_id: req.tenantId,
      lead_id: lead ? lead.id : null,
      quote_id: quote ? quote.id : null,
      title: title || (lead ? `${lead.job_type || 'Job'} — ${lead.name}` : 'Job'),
    });
    await jobsDb.logJobEvent(job.id, req.tenantId, 'job_created', { source: 'console' });
    res.status(201).json({ job });
  } catch (err) {
    console.error('[tenant] job create error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/tenant/jobs/:id — detail: financials, final invoice, event log. */
router.get('/jobs/:id', async (req, res) => {
  try {
    const job = await jobsDb.getJobById(req.params.id);
    if (!job || job.tenant_id !== req.tenantId) return res.status(404).json({ error: 'Job not found.' });
    const [financials, invoice, events] = await Promise.all([
      invoicing.getJobFinancials(job),
      invoicesDb.getFinalInvoiceForJob(job.id),
      jobsDb.getJobEvents(job.id),
    ]);
    res.json({ job, financials, invoice, events });
  } catch (err) {
    console.error('[tenant] job detail error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/tenant/jobs/:id/complete — mark the job complete.
 * This is THE completion action: it stamps completed_at, logs the
 * event, and returns the review prompt payload (Item 6) so the console
 * can ask "Send review request to <customer>?".
 */
router.post('/jobs/:id/complete', async (req, res) => {
  try {
    const job = await jobsDb.markJobCompleted(req.params.id, req.tenantId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    await jobsDb.logJobEvent(job.id, req.tenantId, 'job_completed', {});
    const lead = job.lead_id ? await getLeadById(job.lead_id) : null;
    // The review request exists from this moment (pending the tenant's
    // Yes/Skip at the prompt) so nothing slips through the cracks.
    if (lead) {
      const reviews = require('../services/reviews');
      await reviews.prepareReviewRequest(job, lead).catch(err =>
        console.error('[tenant] review request prep failed:', err.message));
    }
    res.json({
      job,
      review_prompt: lead ? {
        customer_name: lead.name,
        customer_email: lead.email,
        message: `Send review request to ${lead.name}?`,
      } : null,
    });
  } catch (err) {
    console.error('[tenant] job complete error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/tenant/jobs/:id/invoice — create/refresh the final invoice
 * (balance = quote total + approved change orders − deposit paid).
 * Body { send: true } also emails it to the customer with the pay link.
 */
router.post('/jobs/:id/invoice', async (req, res) => {
  try {
    const job = await jobsDb.getJobById(req.params.id);
    if (!job || job.tenant_id !== req.tenantId) return res.status(404).json({ error: 'Job not found.' });

    let invoice = await invoicing.createOrRefreshFinalInvoice(job);
    const payUrl = invoicing.getInvoicePayLinkUrl(invoice.id);
    let emailed = false;

    if (invoice.amount_due_cents <= 0 && invoice.status !== 'paid') {
      // Nothing left to collect — close it out honestly.
      invoice = await invoicesDb.updateInvoice(invoice.id, { status: 'paid', paid_at: new Date().toISOString() });
      await jobsDb.updateJobStatus(job.id, 'paid');
      await jobsDb.logJobEvent(job.id, req.tenantId, 'invoice_paid', { invoice_id: invoice.id, amount_cents: 0, note: 'zero balance' });
    } else if (req.body && req.body.send) {
      const lead = job.lead_id ? await getLeadById(job.lead_id) : null;
      if (!lead) return res.status(400).json({ error: 'Job has no customer to send the invoice to.' });
      const settings = await getAllSettingsDb(req.tenantId);
      const result = await sendFinalInvoice(lead, invoice, payUrl, settings.business_name);
      if (result && result.ok) {
        emailed = true;
        invoice = await invoicesDb.updateInvoice(invoice.id, { status: 'sent', sent_at: new Date().toISOString() });
        await jobsDb.updateJobStatus(job.id, 'invoiced');
        await jobsDb.logJobEvent(job.id, req.tenantId, 'invoice_sent', { invoice_id: invoice.id, to: lead.email });
      } else {
        console.error(`[tenant] final invoice email NOT sent for invoice ${invoice.id} — email service reported failure.`);
        return res.status(502).json({ error: 'Invoice created but the email failed to send. It is saved as a draft — try sending again.', invoice, pay_url: payUrl });
      }
    }

    res.json({ invoice, pay_url: payUrl, emailed });
  } catch (err) {
    console.error('[tenant] invoice error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------------- Change orders (Item 5) ---------------- */

/** GET /api/tenant/jobs/:id/change-orders — the job's change orders. */
router.get('/jobs/:id/change-orders', async (req, res) => {
  try {
    const job = await jobsDb.getJobById(req.params.id);
    if (!job || job.tenant_id !== req.tenantId) return res.status(404).json({ error: 'Job not found.' });
    const { getChangeOrdersForJob } = require('../db/change-orders');
    const change_orders = await getChangeOrdersForJob(job.id);
    res.json({ change_orders });
  } catch (err) {
    console.error('[tenant] change orders list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/tenant/jobs/:id/change-orders — create a change order and
 * (by default) email the customer their approval link. Only APPROVED
 * change orders ever touch the final invoice.
 */
router.post('/jobs/:id/change-orders', async (req, res) => {
  try {
    const job = await jobsDb.getJobById(req.params.id);
    if (!job || job.tenant_id !== req.tenantId) return res.status(404).json({ error: 'Job not found.' });
    const { description, amount_cents, send } = req.body || {};
    if (!description || !String(description).trim()) {
      return res.status(400).json({ error: 'A description of the changed work is required.' });
    }
    const amount = parseInt(amount_cents, 10);
    if (Number.isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amount_cents must be a positive amount.' });
    }
    const coDb = require('../db/change-orders');
    const co = await coDb.createChangeOrder({
      tenant_id: req.tenantId, job_id: job.id,
      description: String(description).trim(), amount_cents: amount,
    });
    await jobsDb.logJobEvent(job.id, req.tenantId, 'change_order_created', {
      change_order_id: co.id, amount_cents: co.amount_cents,
    });

    const { getChangeOrderSignUrl } = require('../services/change-orders');
    const signUrl = getChangeOrderSignUrl(co.token);
    let emailed = false;
    if (send !== false && job.lead_id) {
      const lead = await getLeadById(job.lead_id);
      if (lead) {
        const settings = await getAllSettingsDb(req.tenantId);
        const { sendChangeOrderLink } = require('../services/email');
        const result = await sendChangeOrderLink(lead, co, signUrl, settings.business_name);
        emailed = !!(result && result.ok);
        if (!emailed) {
          console.error(`[tenant] change order email NOT sent for CO ${co.id} — saved as pending; share the link manually.`);
        }
      }
    }
    res.status(201).json({ change_order: co, sign_url: signUrl, emailed });
  } catch (err) {
    console.error('[tenant] change order create error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------------- Review bot (Item 6) ---------------- */

/**
 * POST /api/tenant/jobs/:id/review — the "Yes" at the completion
 * prompt: sends the customer the review email (Google + private paths).
 */
router.post('/jobs/:id/review', async (req, res) => {
  try {
    const job = await jobsDb.getJobById(req.params.id);
    if (!job || job.tenant_id !== req.tenantId) return res.status(404).json({ error: 'Job not found.' });
    const lead = job.lead_id ? await getLeadById(job.lead_id) : null;
    if (!lead) return res.status(400).json({ error: 'Job has no customer to ask.' });
    const reviews = require('../services/reviews');
    const { request, emailed, already } = await reviews.sendReviewForJob(job, lead);
    if (!emailed && !already) {
      return res.status(502).json({ error: 'The review email failed to send. The request is saved — try again.', review_request: request });
    }
    res.json({ review_request: request, sent_to: lead.email, already_sent: !!already });
  } catch (err) {
    console.error('[tenant] review send error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/tenant/jobs/:id/review/skip — the "Skip" at the prompt. */
router.post('/jobs/:id/review/skip', async (req, res) => {
  try {
    const job = await jobsDb.getJobById(req.params.id);
    if (!job || job.tenant_id !== req.tenantId) return res.status(404).json({ error: 'Job not found.' });
    const lead = job.lead_id ? await getLeadById(job.lead_id) : null;
    const reviews = require('../services/reviews');
    const request = await reviews.skipReviewForJob(job, lead);
    res.json({ review_request: request, skipped: true });
  } catch (err) {
    console.error('[tenant] review skip error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/tenant/reviews — review requests + feedback for this tenant. */
router.get('/reviews', async (req, res) => {
  try {
    const reviewsDb = require('../db/reviews');
    const reviews = await reviewsDb.getReviewRequests({ tenantId: req.tenantId });
    res.json({ reviews });
  } catch (err) {
    console.error('[tenant] reviews error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/tenant/invoices — this tenant's invoices. */
router.get('/invoices', async (req, res) => {
  try {
    const invoices = await invoicesDb.getInvoices({ tenantId: req.tenantId });
    res.json({ invoices });
  } catch (err) {
    console.error('[tenant] invoices error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------------- QuickBooks exports (Item 8) ----------------
 * CSV export now; QBO OAuth sync later (see README). These are reads,
 * so even a locked tenant can take their books with them. */

/** GET /api/tenant/exports/quickbooks/invoices.csv */
router.get('/exports/quickbooks/invoices.csv', async (req, res) => {
  try {
    const { buildInvoicesCsv } = require('../services/exports');
    const csv = await buildInvoicesCsv(req.tenantId);
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="crewmind-invoices.csv"').send(csv);
  } catch (err) {
    console.error('[tenant] invoices export error:', err);
    res.status(500).json({ error: 'Export failed.' });
  }
});

/** GET /api/tenant/exports/quickbooks/payments.csv */
router.get('/exports/quickbooks/payments.csv', async (req, res) => {
  try {
    const { buildPaymentsCsv } = require('../services/exports');
    const csv = await buildPaymentsCsv(req.tenantId);
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="crewmind-payments.csv"').send(csv);
  } catch (err) {
    console.error('[tenant] payments export error:', err);
    res.status(500).json({ error: 'Export failed.' });
  }
});

/** GET /api/tenant/usage — this month's metered usage vs included caps. */
router.get('/usage', async (req, res) => {
  try {
    res.json({ usage: await getUsageSummary(req.tenant) });
  } catch (err) {
    console.error('[tenant] usage error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/tenant/scraped-leads — this tenant's saved scraped prospects,
 * newest first. The console's Find customers list reads from here.
 */
router.get('/scraped-leads', async (req, res) => {
  try {
    const prospects = await getScrapedLeadsByTenant(
      req.tenantId,
      parseInt(req.query.limit, 10) || 100
    );
    res.json({ prospects });
  } catch (err) {
    console.error('[tenant] scraped-leads error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/tenant/scrape — find prospect businesses for THIS tenant.
 * Body: { targetService, targetArea, targetZip? }. Results are saved
 * under the tenant (scraped_leads.tenant_id) and metered against the
 * 500/month included prospect allowance (hard cap — 402 when spent).
 * Write-blocked while the tenant is locked, like every console write.
 */
router.post('/scrape', async (req, res) => {
  try {
    const { targetService, targetArea, targetZip } = req.body || {};
    if (!targetService || !targetArea) {
      return res.status(400).json({ error: 'targetService and targetArea are required.' });
    }
    const cap = await checkCap(req.tenant, 'scraped_prospect');
    if (!cap.allowed) {
      return res.status(402).json({
        error: `Monthly prospect allowance reached (${cap.used}/${cap.included} used). It resets on the 1st.`,
        code: 'prospect_cap_reached',
      });
    }
    const remaining = cap.included - cap.used;

    const { runCrewMindScraper } = require('../scraperService.js');
    const zipSuffix = targetZip ? ` ${targetZip}` : '';
    const query = `${targetService} in ${targetArea}${zipSuffix}`;
    const leads = await runCrewMindScraper(query, 20);

    const toSave = leads.slice(0, remaining);
    const { saved, skipped } = await saveScrapedLeads(toSave, { query, tenantId: req.tenantId });
    if (saved > 0) await recordUsage(req.tenantId, 'scraped_prospect', saved);

    res.json({
      success: true,
      total_found: leads.length,
      saved,
      skipped_duplicates: skipped,
      usage: await getUsageSummary(req.tenant),
    });
  } catch (err) {
    console.error('[tenant] scrape error:', err);
    res.status(500).json({ error: err.message || 'Scrape failed.' });
  }
});

module.exports = router;
