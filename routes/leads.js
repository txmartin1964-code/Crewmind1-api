/**
 * routes/leads.js
 * Owns: HTTP handling for lead submission and status endpoints.
 * Does NOT own: AI scoring (services/lead-qualify.js), quote calc (services/quote-engine.js),
 *               email sending (services/email.js), DB writes (db/).
 */

const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const router = express.Router();

const { createLead, updateLeadQualification, getLeadById } = require('../db/leads');
const { getTenantBySlug, getTenantById, isLocked, OPERATOR_TENANT_ID } = require('../db/tenants');
const { createQuote, updateQuoteStatus } = require('../db/quotes');
const { qualifyLead } = require('../services/lead-qualify');
const { generateQuote } = require('../services/quote-engine');
const { sendLeadAck, sendQuoteWithBookingLink } = require('../services/email');
const {
  isStripeConfigured, createOrReuseCheckoutSession, computeDepositCents, getPaymentLinkUrl,
} = require('../services/payments');
const { ensureContractForQuote } = require('../services/contracts');
const { checkCap } = require('../services/usage');
const { recordUsage } = require('../db/usage');

// Multer: memory storage only (Render filesystem is ephemeral)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB per file
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

/**
 * POST /api/leads
 * Submit a new inbound lead. Triggers qualification and quote generation.
 */
router.post('/', upload.array('photos', 5), async (req, res) => {
  try {
    const { name, email, phone, job_type, address, city, zip, sqft, timeline, description } = req.body;

    // Basic validation
    if (!name || !email || !job_type || !address) {
      return res.status(400).json({ error: 'Name, email, job type, and address are required.' });
    }
    if (!email.includes('@')) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }

    // Upload photos to R2 if provided (skipped unless R2_UPLOAD_URL is configured — lead still saves without photos)
    const photo_urls = [];
    if (req.files && req.files.length > 0 && process.env.R2_UPLOAD_URL) {
      for (const file of req.files) {
        try {
          const formData = new FormData();
          formData.append('file', file.buffer, {
            filename: file.originalname,
            contentType: file.mimetype,
          });
          const uploadRes = await fetch(process.env.R2_UPLOAD_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.R2_API_KEY}`,
              ...formData.getHeaders(),
            },
            body: formData,
          });
          const result = await uploadRes.json();
          if (result.success) photo_urls.push(result.file.url);
        } catch (uploadErr) {
          console.error('[leads] photo upload failed:', uploadErr.message);
          // Non-fatal — continue without this photo
        }
      }
    }

    // Resolve which business this lead belongs to. Tenant quote forms
    // pass their slug (?t=<slug> on the form action, or a tenant_slug
    // field); the original Phase 1 form sends neither and lands on the
    // operator tenant (1), unchanged.
    let tenant;
    const slug = (req.body.tenant_slug || req.query.t || '').toString().trim();
    if (slug) {
      tenant = await getTenantBySlug(slug);
      if (!tenant) return res.status(400).json({ error: 'Unknown business.' });
    } else {
      tenant = await getTenantById(OPERATOR_TENANT_ID);
    }
    if (tenant && isLocked(tenant)) {
      return res.status(402).json({ error: 'This business is not currently accepting online quote requests.' });
    }

    // Create lead record
    const lead = await createLead({
      tenant_id: tenant ? tenant.id : OPERATOR_TENANT_ID,
      name, email, phone, job_type, address, city, zip,
      sqft: sqft ? parseInt(sqft) : null,
      timeline, description, photo_urls,
      ip_address: req.ip,
    });

    // Send acknowledgement email (non-blocking)
    sendLeadAck(lead).catch(err => console.error('[leads] ack email failed:', err.message));

    // Qualify and quote asynchronously (don't block the HTTP response)
    setImmediate(() => qualifyAndQuote(lead));

    res.json({ success: true, lead_id: lead.id });
  } catch (err) {
    console.error('[leads] POST error:', err);
    res.status(500).json({ error: 'Failed to submit lead. Please try again.' });
  }
});

/**
 * Async post-submission: qualify lead, generate quote, send email.
 * Runs after HTTP response is sent.
 */
async function qualifyAndQuote(lead) {
  try {
    // 0. Plan cap: AI qualifications are metered (200/month included).
    //    A capped tenant's lead is parked for manual handling — it is
    //    never AI-scored and never charged.
    const tenant = await getTenantById(lead.tenant_id || OPERATOR_TENANT_ID);
    if (tenant) {
      const cap = await checkCap(tenant, 'ai_qualified_lead');
      if (!cap.allowed) {
        await updateLeadQualification(lead.id, {
          status: 'new',
          qualification_status: 'quota_exceeded',
          ai_score: null,
          ai_reasoning: 'Monthly AI qualification allowance reached for this business. Review this lead manually in the console.',
        });
        console.log(`[leads] lead ${lead.id} parked: AI qualification cap reached for tenant ${tenant.id}.`);
        return;
      }
    }

    // 1. AI qualification
    const qualification = await qualifyLead(lead);
    const updatedLead = await updateLeadQualification(lead.id, qualification);

    // Meter the qualification — only when the AI actually scored the
    // lead and did not disqualify it. Spam/disqualified leads never
    // count against the cap and are never charged.
    if (tenant && qualification.ai_score != null && updatedLead.qualification_status !== 'disqualified') {
      await recordUsage(tenant.id, 'ai_qualified_lead', 1).catch(err =>
        console.error('[leads] usage recording failed:', err.message)
      );
    }

    // 2. Generate quote for qualified leads (skip disqualified)
    if (updatedLead.status === 'qualified' || updatedLead.qualification_status === 'manual_review') {
      const quoteData = await generateQuote(updatedLead);
      const quote = await createQuote(quoteData);

      // 2b. Auto-create a draft contract from the quote (idempotent).
      //     Non-fatal: a contract can also be created later from the
      //     admin console, so a failure here must not break the pipeline.
      try {
        await ensureContractForQuote(updatedLead, quote);
      } catch (contractErr) {
        console.error(`[leads] draft contract creation failed for quote ${quote.id}:`, contractErr.message);
      }

      // 3. Send quote + booking link for qualified leads
      if (updatedLead.status === 'qualified') {
        const bookingUrl = `${process.env.APP_URL || 'https://crewmind1-api.onrender.com'}/book?lead=${lead.id}&quote=${quote.id}`;

        // Deposit payment link — only when Stripe is configured. Creating
        // the session now stores its id on the quote; the emailed URL is
        // our stable redirector, which reuses the live session at click
        // time. A Stripe failure must never block the quote email.
        let payment = null;
        if (isStripeConfigured()) {
          try {
            const session = await createOrReuseCheckoutSession(updatedLead, quote);
            if (session) {
              payment = {
                url: getPaymentLinkUrl(quote.id),
                deposit_cents: await computeDepositCents(quote),
              };
            }
          } catch (payErr) {
            console.error(`[leads] could not create checkout session for quote ${quote.id}:`, payErr.message);
          }
        }

        const emailResult = await sendQuoteWithBookingLink(updatedLead, quote, bookingUrl, payment);
        if (emailResult && emailResult.ok) {
          // Only now is the quote actually 'sent' — keep its status honest.
          await updateQuoteStatus(quote.id, 'sent');
        } else {
          console.error(`[leads] quote email NOT sent for lead ${lead.id} (quote ${quote.id}) — email service reported failure. Quote remains 'draft' so the failure is visible.`);
        }
      }
    }
  } catch (err) {
    console.error('[leads] qualifyAndQuote failed for lead', lead.id, ':', err.message);
  }
}

/**
 * GET /api/leads/:id/status
 * Check lead status and quote info (for polling from thank-you page).
 */
router.get('/:id/status', async (req, res) => {
  try {
    const lead = await getLeadById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json({
      id: lead.id,
      status: lead.status,
      qualification_status: lead.qualification_status,
      ai_score: lead.ai_score,
    });
  } catch (err) {
    console.error('[leads] status error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
