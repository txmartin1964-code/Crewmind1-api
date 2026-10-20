/**
 * db/change-orders.js
 * Owns: All database queries for change_orders (migration 009).
 * Does NOT own: document text/hashing (services/change-orders.js),
 * invoice math (services/invoicing.js).
 */

const pool = require('./index');
const crypto = require('crypto');

async function createChangeOrder({ tenant_id, job_id, description, amount_cents }) {
  const token = crypto.randomBytes(32).toString('hex');
  const result = await pool.query(
    `INSERT INTO change_orders (tenant_id, job_id, description, amount_cents, token, token_expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '30 days') RETURNING *`,
    [tenant_id, job_id, description, amount_cents, token]
  );
  return result.rows[0];
}

async function getChangeOrderById(id) {
  const result = await pool.query('SELECT * FROM change_orders WHERE id=$1', [id]);
  return result.rows[0] || null;
}

async function getChangeOrderByToken(token) {
  const result = await pool.query('SELECT * FROM change_orders WHERE token=$1', [token]);
  return result.rows[0] || null;
}

async function getChangeOrdersForJob(jobId) {
  const result = await pool.query(
    'SELECT * FROM change_orders WHERE job_id=$1 ORDER BY created_at ASC', [jobId]
  );
  return result.rows;
}

async function sumApprovedChangeOrders(jobId) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount_cents), 0)::int AS total
     FROM change_orders WHERE job_id=$1 AND status='approved'`,
    [jobId]
  );
  return result.rows[0].total;
}

/** Records the customer's approval signature. Only fires from 'pending'. */
async function markChangeOrderSigned(id, { signedName, signatureHash, signerIp }) {
  const result = await pool.query(
    `UPDATE change_orders
     SET status='approved', signed_name=$2, signature_hash=$3, signed_at=NOW(),
         signer_ip=$4, updated_at=NOW()
     WHERE id=$1 AND status='pending' RETURNING *`,
    [id, signedName, signatureHash, signerIp || null]
  );
  return result.rows[0] || null;
}

async function markChangeOrderDeclined(id) {
  const result = await pool.query(
    `UPDATE change_orders SET status='declined', updated_at=NOW()
     WHERE id=$1 AND status='pending' RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

module.exports = {
  createChangeOrder, getChangeOrderById, getChangeOrderByToken,
  getChangeOrdersForJob, sumApprovedChangeOrders,
  markChangeOrderSigned, markChangeOrderDeclined,
};
