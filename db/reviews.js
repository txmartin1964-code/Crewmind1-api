/**
 * db/reviews.js
 * Owns: All database queries for review_requests (migration 010).
 * Does NOT own: email content (services/email.js), flow decisions
 * (services/reviews.js).
 */

const pool = require('./index');
const crypto = require('crypto');

async function getOrCreateReviewRequest({ tenant_id, job_id, lead_id }) {
  const existing = await getReviewRequestByJob(job_id);
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString('hex');
  const result = await pool.query(
    `INSERT INTO review_requests (tenant_id, job_id, lead_id, token)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (job_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
     RETURNING *`,
    [tenant_id, job_id, lead_id, token]
  );
  return result.rows[0];
}

async function getReviewRequestByJob(jobId) {
  const result = await pool.query('SELECT * FROM review_requests WHERE job_id=$1', [jobId]);
  return result.rows[0] || null;
}

async function getReviewRequestByToken(token) {
  const result = await pool.query('SELECT * FROM review_requests WHERE token=$1', [token]);
  return result.rows[0] || null;
}

async function markReviewSent(id) {
  const result = await pool.query(
    `UPDATE review_requests SET status='sent', sent_at=NOW(), updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

async function markReviewSkipped(id) {
  const result = await pool.query(
    `UPDATE review_requests SET status='skipped', updated_at=NOW()
     WHERE id=$1 AND status='pending_prompt' RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

async function saveFeedback(id, { feedback_text, feedback_rating }) {
  const result = await pool.query(
    `UPDATE review_requests
     SET status='feedback_submitted', feedback_text=$2, feedback_rating=$3,
         feedback_at=NOW(), updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [id, feedback_text || null, feedback_rating || null]
  );
  return result.rows[0] || null;
}

async function markThanksSent(id) {
  const result = await pool.query(
    'UPDATE review_requests SET thanks_sent_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *',
    [id]
  );
  return result.rows[0] || null;
}

async function getReviewRequests({ tenantId, limit = 100 } = {}) {
  const params = [];
  let where = '';
  if (tenantId) { params.push(tenantId); where = `WHERE rr.tenant_id=$${params.length}`; }
  params.push(limit);
  const result = await pool.query(
    `SELECT rr.*, l.name AS customer_name, l.email AS customer_email, j.title AS job_title
     FROM review_requests rr
     LEFT JOIN leads l ON l.id = rr.lead_id
     LEFT JOIN jobs j ON j.id = rr.job_id
     ${where}
     ORDER BY rr.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

module.exports = {
  getOrCreateReviewRequest, getReviewRequestByJob, getReviewRequestByToken,
  markReviewSent, markReviewSkipped, saveFeedback, markThanksSent, getReviewRequests,
};
