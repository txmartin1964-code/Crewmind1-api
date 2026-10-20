/**
 * db/contracts.js
 * Owns: All database queries for the contracts table (migration 005).
 * Does NOT own: contract content generation (services/contracts.js),
 * HTTP handling (routes/contracts.js).
 */

const pool = require('./index');
const crypto = require('crypto');

function generateAccessToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function createContract(data) {
  const {
    lead_id, quote_id, title, scope_of_work, total_cents, deposit_cents,
    terms, customer_name, customer_email, job_address,
  } = data;
  const tenantId = data.tenant_id || 1;
  const result = await pool.query(
    `INSERT INTO contracts (
       tenant_id, lead_id, quote_id, contract_number, access_token, status, title,
       scope_of_work, total_cents, deposit_cents, terms,
       customer_name, customer_email, job_address
     )
     VALUES (
       $1, $2, $3,
       'CM-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(nextval('contracts_number_seq')::text, 4, '0'),
       $4, 'draft', $5, $6, $7, $8, $9, $10, $11, $12
     )
     RETURNING *`,
    [tenantId, lead_id, quote_id, generateAccessToken(), title, scope_of_work,
     total_cents, deposit_cents, terms, customer_name, customer_email, job_address]
  );
  return result.rows[0];
}

async function getContractById(id) {
  const result = await pool.query('SELECT * FROM contracts WHERE id=$1', [id]);
  return result.rows[0] || null;
}

async function getContractByToken(token) {
  const result = await pool.query('SELECT * FROM contracts WHERE access_token=$1', [token]);
  return result.rows[0] || null;
}

async function getContractByQuoteId(quoteId) {
  const result = await pool.query(
    `SELECT * FROM contracts WHERE quote_id=$1 AND status <> 'void' ORDER BY id DESC LIMIT 1`,
    [quoteId]
  );
  return result.rows[0] || null;
}

async function getContracts({ tenantId, limit = 100 } = {}) {
  const params = [];
  let where = '';
  if (tenantId) {
    params.push(tenantId);
    where = `WHERE c.tenant_id=$${params.length}`;
  }
  params.push(limit);
  const result = await pool.query(
    `SELECT c.*, l.name AS lead_name
     FROM contracts c
     LEFT JOIN leads l ON l.id = c.lead_id
     ${where}
     ORDER BY c.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

async function updateContractStatus(id, status) {
  const result = await pool.query(
    `UPDATE contracts SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
    [status, id]
  );
  return result.rows[0];
}

/**
 * Records the signing event. Only applies while the contract is in a
 * signable state — the WHERE clause is the lock: once signed (or void),
 * this update matches nothing and returns null.
 */
async function markContractSigned(id, { signedName, signatureText, signerIp, signerUserAgent, documentSha256 }) {
  const result = await pool.query(
    `UPDATE contracts
     SET status='signed', signed_name=$1, signature_text=$2, signer_ip=$3,
         signer_user_agent=$4, document_sha256=$5, signed_at=NOW(), updated_at=NOW()
     WHERE id=$6 AND status='sent'
     RETURNING *`,
    [signedName, signatureText, signerIp, signerUserAgent, documentSha256, id]
  );
  return result.rows[0] || null;
}

module.exports = {
  createContract, getContractById, getContractByToken, getContractByQuoteId,
  getContracts, updateContractStatus, markContractSigned,
};
