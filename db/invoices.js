/**
 * db/invoices.js
 * Owns: All database queries for invoices (migration 008).
 * Does NOT own: invoice math (services/invoicing.js), Stripe sessions
 * (services/invoicing.js via services/payments.js Stripe client).
 */

const pool = require('./index');

async function createInvoice({ tenant_id, job_id = null, quote_id = null, kind = 'final',
  total_cents = 0, deposit_paid_cents = 0, change_orders_cents = 0, amount_due_cents = 0 }) {
  const result = await pool.query(
    `INSERT INTO invoices (tenant_id, job_id, quote_id, kind, total_cents, deposit_paid_cents, change_orders_cents, amount_due_cents)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [tenant_id, job_id, quote_id, kind, total_cents, deposit_paid_cents, change_orders_cents, amount_due_cents]
  );
  const invoice = result.rows[0];
  const number = `INV-${invoice.tenant_id}-${String(invoice.id).padStart(4, '0')}`;
  const numbered = await pool.query(
    'UPDATE invoices SET invoice_number=$1 WHERE id=$2 RETURNING *',
    [number, invoice.id]
  );
  return numbered.rows[0];
}

async function getInvoiceById(id) {
  const result = await pool.query('SELECT * FROM invoices WHERE id=$1', [id]);
  return result.rows[0] || null;
}

async function getFinalInvoiceForJob(jobId) {
  const result = await pool.query(
    `SELECT * FROM invoices WHERE job_id=$1 AND kind='final' ORDER BY id DESC LIMIT 1`,
    [jobId]
  );
  return result.rows[0] || null;
}

async function getInvoices({ tenantId, limit = 100 } = {}) {
  const params = [];
  let where = '';
  if (tenantId) { params.push(tenantId); where = `WHERE tenant_id=$${params.length}`; }
  params.push(limit);
  const result = await pool.query(
    `SELECT * FROM invoices ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

const UPDATABLE = ['total_cents', 'deposit_paid_cents', 'change_orders_cents', 'amount_due_cents',
  'status', 'stripe_session_id', 'stripe_payment_intent_id', 'sent_at', 'paid_at'];

async function updateInvoice(id, fields) {
  const keys = Object.keys(fields || {}).filter(k => UPDATABLE.includes(k));
  if (!keys.length) return getInvoiceById(id);
  const params = [];
  const sets = keys.map(k => { params.push(fields[k]); return `${k}=$${params.length}`; });
  params.push(id);
  const result = await pool.query(
    `UPDATE invoices SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${params.length} RETURNING *`,
    params
  );
  return result.rows[0] || null;
}

async function markInvoicePaid(id, { amountPaidCents, stripePaymentIntentId } = {}) {
  const result = await pool.query(
    `UPDATE invoices
     SET status='paid', paid_at=NOW(), updated_at=NOW(),
         stripe_payment_intent_id=COALESCE($2, stripe_payment_intent_id)
     WHERE id=$1 RETURNING *`,
    [id, stripePaymentIntentId || null]
  );
  return result.rows[0] || null;
}

module.exports = {
  createInvoice, getInvoiceById, getFinalInvoiceForJob, getInvoices,
  updateInvoice, markInvoicePaid,
};
