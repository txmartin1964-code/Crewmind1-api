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
const { createQuote } = require('../db/quotes');
const { qualifyLead } = require('../services/lead-qualify');
const { generateQuote } = require('../services/quote-engine');
const { sendLeadAck, sendQuoteWithBookingLink, registerContact } = require('../services/email');

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

    // Upload photos to R2 if provided
    const photo_urls = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        try {
          const formData = new FormData();
          formData.append('file', file.buffer, {
            filename: file.originalname,
            contentType: file.mimetype,
          });
          const uploadRes = await fetch('https://polsia.com/api/proxy/r2/upload', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.POLSIA_API_KEY}`,
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

    // Create lead record
    const lead = await createLead({
      name, email, phone, job_type, address, city, zip,
      sqft: sqft ? parseInt(sqft) : null,
      timeline, description, photo_urls,
      ip_address: req.ip,
    });

    // Register contact for email deliverability
    registerContact({ email, name, source: 'contact_form' }).catch(() => {});

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
    // 1. AI qualification
    const qualification = await qualifyLead(lead);
    const updatedLead = await updateLeadQualification(lead.id, qualification);

    // 2. Generate quote for qualified leads (skip disqualified)
    if (updatedLead.status === 'qualified' || updatedLead.qualification_status === 'manual_review') {
      const quoteData = await generateQuote(updatedLead);
      const quote = await createQuote(quoteData);

      // 3. Send quote + booking link for qualified leads
      if (updatedLead.status === 'qualified') {
        const bookingUrl = `${process.env.APP_URL || 'https://crewmind-10.polsia.app'}/book?lead=${lead.id}&quote=${quote.id}`;
        await sendQuoteWithBookingLink(updatedLead, quote, bookingUrl);
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
