/**
 * routes/reviews.js
 * Owns: Public feedback endpoints for the review bot.
 *   GET  /api/reviews/view/:token     — what the feedback page shows.
 *   POST /api/reviews/feedback/:token — customer submits private
 *        feedback; saved to the tenant, logged on the job, and the
 *        customer gets a thank-you email.
 */

const express = require('express');
const router = express.Router();

const reviewsDb = require('../db/reviews');
const { getLeadById } = require('../db/leads');
const { getAllSettings } = require('../db/settings');
const { logJobEvent } = require('../db/jobs');
const { sendFeedbackThanks } = require('../services/email');

router.get('/view/:token', async (req, res) => {
  try {
    const request = await reviewsDb.getReviewRequestByToken(req.params.token);
    if (!request) return res.status(404).json({ error: 'Feedback link not found.' });
    const settings = await getAllSettings(request.tenant_id);
    res.json({
      business_name: settings.business_name || 'CrewMind',
      google_review_url: settings.google_review_url || null,
      status: request.status,
      feedback_submitted: request.status === 'feedback_submitted',
    });
  } catch (err) {
    console.error('[reviews] view error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/feedback/:token', async (req, res) => {
  try {
    const request = await reviewsDb.getReviewRequestByToken(req.params.token);
    if (!request) return res.status(404).json({ error: 'Feedback link not found.' });
    if (request.status === 'feedback_submitted') {
      return res.status(409).json({ error: 'Feedback already submitted for this job — thank you!' });
    }
    if (request.status === 'skipped' || request.status === 'pending_prompt') {
      return res.status(409).json({ error: 'This feedback link is not active.' });
    }
    const text = String(req.body?.feedback_text || '').trim();
    if (!text) return res.status(400).json({ error: 'Please write a few words so the business knows how it went.' });
    let rating = parseInt(req.body?.feedback_rating, 10);
    if (Number.isNaN(rating) || rating < 1 || rating > 5) rating = null;

    const saved = await reviewsDb.saveFeedback(request.id, { feedback_text: text, feedback_rating: rating });
    await logJobEvent(request.job_id, request.tenant_id, 'review_feedback', {
      review_request_id: request.id, rating,
      feedback_preview: text.slice(0, 200),
    });

    // Thank-you email — non-fatal; the feedback itself is already saved.
    let thanked = false;
    const lead = request.lead_id ? await getLeadById(request.lead_id) : null;
    if (lead) {
      const settings = await getAllSettings(request.tenant_id);
      const result = await sendFeedbackThanks(lead, settings.business_name);
      if (result && result.ok) {
        thanked = true;
        await reviewsDb.markThanksSent(request.id);
        await logJobEvent(request.job_id, request.tenant_id, 'review_thanks_sent', { review_request_id: request.id });
      }
    }

    res.json({ ok: true, thanked, feedback_at: saved.feedback_at });
  } catch (err) {
    console.error('[reviews] feedback error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
