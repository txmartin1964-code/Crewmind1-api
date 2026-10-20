/**
 * services/exports.js
 * Owns: Per-tenant CSV exports, currently for QuickBooks.
 * Does NOT own: invoice storage (db/invoices.js), QBO OAuth (future —
 * see README "QuickBooks: export now, OAuth sync later").
 *
 * invoices.csv follows the QuickBooks Online invoice-import layout
 * (InvoiceNo, Customer, InvoiceDate, DueDate, Item, ItemDescription,
 * ItemQuantity, ItemRate, ItemAmount) so it can be imported via
 * QBO Settings → Import Data → Invoices.
 * payments.csv is a simple register of money actually received
 * (deposits + invoice payments) for reconciliation.
 */

const pool = require('../db/index');

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}

function dollars(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function ymd(date) {
  if (!date) return '';
  const d = new Date(date);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

async function buildInvoicesCsv(tenantId) {
  const result = await pool.query(
    `SELECT i.*, l.name AS customer_name, j.title AS job_title
     FROM invoices i
     LEFT JOIN jobs j ON j.id = i.job_id
     LEFT JOIN leads l ON l.id = j.lead_id
     WHERE i.tenant_id = $1
     ORDER BY i.created_at ASC`,
    [tenantId]
  );
  const headers = ['InvoiceNo', 'Customer', 'InvoiceDate', 'DueDate', 'Item', 'ItemDescription', 'ItemQuantity', 'ItemRate', 'ItemAmount', '*InvoiceStatus', 'DepositPaid', 'BalanceDue'];
  const rows = result.rows.map(inv => [
    inv.invoice_number || String(inv.id),
    inv.customer_name || '',
    ymd(inv.created_at),
    ymd(inv.created_at),
    'Services',
    inv.job_title || 'Completed work',
    1,
    dollars(inv.total_cents),
    dollars(inv.total_cents),
    inv.status,
    dollars(inv.deposit_paid_cents),
    dollars(inv.amount_due_cents),
  ]);
  return toCsv(headers, rows);
}

async function buildPaymentsCsv(tenantId) {
  const headers = ['Date', 'Type', 'Number', 'Customer', 'Memo', 'Amount'];
  const rows = [];

  const deposits = await pool.query(
    `SELECT q.id, q.amount_paid_cents, q.updated_at, q.payment_status, l.name AS customer_name
     FROM quotes q
     LEFT JOIN leads l ON l.id = q.lead_id
     WHERE q.tenant_id = $1 AND q.payment_status IN ('deposit_paid', 'paid') AND q.amount_paid_cents > 0
     ORDER BY q.updated_at ASC`,
    [tenantId]
  );
  for (const q of deposits.rows) {
    rows.push([ymd(q.updated_at), 'Deposit payment', `QUOTE-${q.id}`, q.customer_name || '', 'Job deposit received via Stripe', dollars(q.amount_paid_cents)]);
  }

  const invoicePayments = await pool.query(
    `SELECT i.invoice_number, i.amount_due_cents, i.paid_at, l.name AS customer_name
     FROM invoices i
     LEFT JOIN jobs j ON j.id = i.job_id
     LEFT JOIN leads l ON l.id = j.lead_id
     WHERE i.tenant_id = $1 AND i.status = 'paid' AND i.paid_at IS NOT NULL AND i.amount_due_cents > 0
     ORDER BY i.paid_at ASC`,
    [tenantId]
  );
  for (const p of invoicePayments.rows) {
    rows.push([ymd(p.paid_at), 'Invoice payment', p.invoice_number || '', p.customer_name || '', 'Final invoice balance received via Stripe', dollars(p.amount_due_cents)]);
  }

  return toCsv(headers, rows);
}

module.exports = { buildInvoicesCsv, buildPaymentsCsv };
