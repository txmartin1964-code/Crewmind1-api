/**
 * db/jobs.js
 * Owns: All database queries for jobs and job_events (migration 008).
 * Does NOT own: invoicing math (services/invoicing.js), review flow
 * (services/reviews.js).
 */

const pool = require('./index');

async function createJob({ tenant_id = 1, lead_id = null, quote_id = null, appointment_id = null, title = null, status = 'scheduled' }) {
  const result = await pool.query(
    `INSERT INTO jobs (tenant_id, lead_id, quote_id, appointment_id, title, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [tenant_id, lead_id, quote_id, appointment_id, title, status]
  );
  return result.rows[0];
}

async function getJobById(id) {
  const result = await pool.query('SELECT * FROM jobs WHERE id=$1', [id]);
  return result.rows[0] || null;
}

/** Find the job for a quote (one job per quote in the current model). */
async function getJobByQuoteId(quoteId) {
  const result = await pool.query(
    'SELECT * FROM jobs WHERE quote_id=$1 ORDER BY id ASC LIMIT 1', [quoteId]
  );
  return result.rows[0] || null;
}

async function getJobs({ tenantId, limit = 100 } = {}) {
  const params = [];
  let where = '';
  if (tenantId) { params.push(tenantId); where = `WHERE j.tenant_id=$${params.length}`; }
  params.push(limit);
  const result = await pool.query(
    `SELECT j.*, l.name AS customer_name, l.email AS customer_email, l.job_type,
            q.total_cents AS quote_total_cents, q.payment_status AS quote_payment_status
     FROM jobs j
     LEFT JOIN leads l ON l.id = j.lead_id
     LEFT JOIN quotes q ON q.id = j.quote_id
     ${where}
     ORDER BY j.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

async function updateJobStatus(id, status, tenantId) {
  const params = [status, id];
  let sql = 'UPDATE jobs SET status=$1, updated_at=NOW() WHERE id=$2';
  if (tenantId) { params.push(tenantId); sql += ` AND tenant_id=$${params.length}`; }
  sql += ' RETURNING *';
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

async function markJobCompleted(id, tenantId) {
  const result = await pool.query(
    `UPDATE jobs SET status='completed', completed_at=NOW(), updated_at=NOW()
     WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [id, tenantId]
  );
  return result.rows[0] || null;
}

async function logJobEvent(jobId, tenantId, eventType, detail = {}) {
  const result = await pool.query(
    `INSERT INTO job_events (job_id, tenant_id, event_type, detail)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [jobId, tenantId, eventType, JSON.stringify(detail || {})]
  );
  return result.rows[0];
}

async function getJobEvents(jobId, limit = 100) {
  const result = await pool.query(
    'SELECT * FROM job_events WHERE job_id=$1 ORDER BY created_at ASC LIMIT $2',
    [jobId, limit]
  );
  return result.rows;
}

module.exports = {
  createJob, getJobById, getJobByQuoteId, getJobs,
  updateJobStatus, markJobCompleted, logJobEvent, getJobEvents,
};
