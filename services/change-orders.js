/**
 * services/change-orders.js
 * Owns: The change-order document: canonical text and its SHA-256
 * fingerprint, mirroring services/contracts.js — the text the customer
 * sees is the text that gets hashed at signing, so the stored hash
 * proves exactly what was approved.
 */

const crypto = require('crypto');

function changeOrderDocumentText(co, job, lead, settings) {
  const business = (settings && settings.business_name) || 'CrewMind';
  const amount = (co.amount_cents / 100).toFixed(2);
  const lines = [
    `CHANGE ORDER — ${business}`,
    '',
    `Job: ${job.title || ('Job #' + job.id)}`,
    `Customer: ${lead ? lead.name : ''}`,
    '',
    'Description of additional / changed work:',
    co.description,
    '',
    `Amount: $${amount} (added to the final invoice for this job)`,
    '',
    'By signing, the customer approves the work described above at the',
    'amount shown. The approved amount is added to the final invoice.',
    'All other terms of the original agreement remain in effect.',
  ];
  return lines.join('\n');
}

function hashChangeOrder(co, job, lead, settings) {
  return crypto.createHash('sha256')
    .update(changeOrderDocumentText(co, job, lead, settings), 'utf8')
    .digest('hex');
}

function getChangeOrderSignUrl(token) {
  const base = process.env.APP_URL || 'http://localhost:3000';
  return `${base}/change-order.html?c=${token}`;
}

module.exports = { changeOrderDocumentText, hashChangeOrder, getChangeOrderSignUrl };
