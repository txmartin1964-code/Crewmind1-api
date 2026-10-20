/**
 * services/reviews.js
 * Owns: The review-bot flow (email channel). Trigger: a job is marked
 * complete and the tenant confirms at the prompt (default = send).
 * The email offers EVERY customer the same two paths side by side —
 * "Share on Google" (the tenant's review link) and "Tell us privately"
 * (feedback form) — no sentiment gating, per platform policy. Private
 * feedback lands on the tenant and triggers a thank-you email.
 * Everything is logged on the job (job_events).
 */

const reviewsDb = require('../db/reviews');
const { getAllSettings } = require('../db/settings');
const { logJobEvent } = require('../db/jobs');
const { sendReviewRequest } = require('./email');

function getFeedbackUrl(token) {
  const base = process.env.APP_URL || 'http://localhost:3000';
  return `${base}/feedback.html?t=${token}`;
}

/** Creates (or fetches) the pending review request for a completed job. */
async function prepareReviewRequest(job, lead) {
  return reviewsDb.getOrCreateReviewRequest({
    tenant_id: job.tenant_id,
    job_id: job.id,
    lead_id: lead ? lead.id : job.lead_id,
  });
}

/** Sends the review-request email. Returns { request, emailed }. */
async function sendReviewForJob(job, lead) {
  const request = await prepareReviewRequest(job, lead);
  if (request.status === 'sent' || request.status === 'feedback_submitted') {
    return { request, emailed: false, already: true };
  }
  const settings = await getAllSettings(job.tenant_id);
  const result = await sendReviewRequest(lead, {
    googleUrl: settings.google_review_url || null,
    feedbackUrl: getFeedbackUrl(request.token),
    businessName: settings.business_name,
  });
  if (!result || !result.ok) {
    console.error(`[reviews] review email NOT sent for job ${job.id} — email service reported failure.`);
    return { request, emailed: false };
  }
  const sent = await reviewsDb.markReviewSent(request.id);
  await logJobEvent(job.id, job.tenant_id, 'review_requested', {
    review_request_id: request.id, to: lead.email,
    google_link_included: !!settings.google_review_url,
  });
  return { request: sent, emailed: true };
}

/** Tenant chose Skip at the completion prompt. */
async function skipReviewForJob(job, lead) {
  const request = await prepareReviewRequest(job, lead);
  const skipped = await reviewsDb.markReviewSkipped(request.id);
  await logJobEvent(job.id, job.tenant_id, 'review_skipped', { review_request_id: request.id });
  return skipped || request;
}

module.exports = { prepareReviewRequest, sendReviewForJob, skipReviewForJob, getFeedbackUrl };
