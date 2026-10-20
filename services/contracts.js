/**
 * services/contracts.js
 *
 * Owns: Contract content generation — scope of work, the default terms
 * template, the canonical text that gets hashed at signing, and the
 * print-friendly HTML rendering of a contract.
 * Does NOT own: DB writes (db/contracts.js), HTTP handling
 * (routes/contracts.js), email delivery (services/email.js).
 *
 * IMPORTANT: the terms below are a STARTING TEMPLATE, not legal advice.
 * The owner should have a Texas attorney review them before relying on
 * signed contracts in a dispute.
 */

const crypto = require('crypto');
const { getAllSettings } = require('../db/settings');
const { createContract, getContractByQuoteId } = require('../db/contracts');
const { computeDepositCents, getBaseUrl } = require('./payments');

const money = cents => '$' + ((cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function jobLabel(jobType) {
  return (jobType || 'General Service').replace(/_/g, ' ');
}

function parseLineItems(quote) {
  if (!quote) return [];
  const items = quote.line_items;
  if (Array.isArray(items)) return items;
  if (typeof items === 'string') {
    try { return JSON.parse(items); } catch { return []; }
  }
  return [];
}

/** Builds the scope-of-work text from the lead and its quote. */
function buildScopeOfWork(lead, quote) {
  const lines = [];
  lines.push(`Service: ${jobLabel(lead.job_type || quote?.job_type)}`);
  if (lead.sqft) lines.push(`Approximate size: ${Number(lead.sqft).toLocaleString()} sq ft`);
  if (lead.timeline) lines.push(`Requested timeline: ${lead.timeline}`);
  if (lead.description) {
    lines.push('');
    lines.push('Customer description of the work:');
    lines.push(lead.description);
  }
  const items = parseLineItems(quote);
  if (items.length) {
    lines.push('');
    lines.push('Estimate line items:');
    for (const item of items) {
      lines.push(`- ${item.label}: ${money(item.amount_cents)}`);
    }
  }
  return lines.join('\n');
}

/**
 * The default terms template. Placeholders like [BUSINESS ADDRESS] appear
 * in the rendered contract when the corresponding setting is empty, so
 * missing business details are obvious rather than silently blank.
 */
function buildTerms(settings, contract) {
  const biz = settings.business_name || 'CrewMind';
  const bizAddress = settings.business_address || '[BUSINESS ADDRESS — set in Admin Console → Settings]';
  const bizPhone = settings.business_phone || '[BUSINESS PHONE — set in Admin Console → Settings]';
  const balanceCents = (contract.total_cents || 0) - (contract.deposit_cents || 0);

  return `SERVICE AGREEMENT — TERMS AND CONDITIONS

1. PARTIES AND WORK. This Agreement is between ${biz} ("Contractor"), ${bizAddress}, ${bizPhone}, and the customer named above ("Customer"). Contractor will perform the work described in the Scope of Work at the job address above (the "Work").

2. PRICE AND PAYMENT SCHEDULE. The total contract price is ${money(contract.total_cents)}. A deposit of ${money(contract.deposit_cents)} is due upon signing this Agreement, payable through the secure payment link provided by Contractor. The remaining balance of ${money(balanceCents)} is due upon completion of the Work. Amounts not paid within 15 days of the due date may accrue a late charge of 1.5% per month or the maximum allowed by Texas law, whichever is less.

3. CHANGE ORDERS. Any change to the Scope of Work must be approved in writing (email is sufficient) by both parties BEFORE the changed work begins, including the price adjustment for the change. Contractor is not obligated to perform changed or additional work without a written change order, and Customer is not obligated to pay for unauthorized changes.

4. WARRANTY. Contractor warrants its workmanship for one (1) year from completion [PLACEHOLDER PERIOD — confirm before use] against defects in installation under normal use. This warranty covers labor to repair or replace defective workmanship. Materials are covered by their manufacturers' warranties, if any. This warranty does not cover damage from misuse, neglect, acts of nature, or work by others.

5. CANCELLATION AND RESCHEDULING. Either party may reschedule an appointment with at least 24 hours' notice at no charge. Customer may cancel this Agreement within three (3) business days of signing for a full refund of any deposit paid, as provided by Texas law for covered home solicitation sales. After that window, if Customer cancels after materials have been ordered or work has begun, Contractor may deduct documented material and labor costs from any deposit refund.

6. SCHEDULE AND CONDITIONS OF PREMISES. Start and completion dates are good-faith estimates and may shift for weather, material availability, or conditions discovered after work begins (including hidden or pre-existing damage). If concealed conditions materially change the Work, the parties will handle the difference through a written change order under Section 3.

7. PERMITS AND COMPLIANCE. Unless otherwise stated in the Scope of Work, Contractor will obtain required permits for the Work and will perform the Work in compliance with applicable building codes and Texas law, including the Texas Property Code Chapter 53 (mechanic's lien) notice provisions where they apply.

8. ENTIRE AGREEMENT. This Agreement, including the Scope of Work and price above, is the entire agreement between the parties for the Work and supersedes any prior discussions, proposals, or estimates. Amendments must be in writing and signed (including electronically) by both parties.

9. ELECTRONIC SIGNATURES AND RECORDS. The parties agree to conduct this transaction electronically. Customer's typed name and "I agree" confirmation below constitute Customer's electronic signature under the federal ESIGN Act (15 U.S.C. § 7001 et seq.) and the Texas Uniform Electronic Transactions Act (Tex. Bus. & Com. Code ch. 322), and are intended to be as binding as a handwritten signature. Customer consents to receive this contract and related records electronically and may request a paper copy from Contractor at any time.

[STARTING TEMPLATE ONLY — NOT LEGAL ADVICE. Have a Texas attorney review before relying on this contract.]`;
}

/**
 * The canonical contract content hashed at signing time. Built ONLY from
 * stored contract fields so anyone can recompute it later and verify the
 * signed document has not changed.
 */
function canonicalContractText(contract) {
  return JSON.stringify({
    contract_number: contract.contract_number,
    title: contract.title,
    customer_name: contract.customer_name,
    customer_email: contract.customer_email,
    job_address: contract.job_address,
    scope_of_work: contract.scope_of_work,
    total_cents: contract.total_cents,
    deposit_cents: contract.deposit_cents,
    terms: contract.terms,
  });
}

function hashContract(contract) {
  return crypto.createHash('sha256').update(canonicalContractText(contract), 'utf8').digest('hex');
}

function getContractSignUrl(contract) {
  return `${getBaseUrl()}/contract.html?c=${contract.access_token}`;
}

/**
 * Creates a draft contract for a quote if none exists yet (idempotent —
 * returns the existing non-void contract for the quote). Called
 * automatically when a quote is created, and by the admin "Create
 * contract" action for quotes that predate contracts.
 */
async function ensureContractForQuote(lead, quote) {
  const existing = await getContractByQuoteId(quote.id);
  if (existing) return existing;

  const tenantId = quote.tenant_id || lead.tenant_id || 1;
  const settings = await getAllSettings(tenantId);
  const depositCents = await computeDepositCents(quote);
  const jobAddress = [lead.address, lead.city, lead.zip].filter(Boolean).join(', ');

  const content = {
    total_cents: quote.total_cents || 0,
    deposit_cents: depositCents,
  };
  const terms = buildTerms({
    business_name: settings.business_name || 'CrewMind',
    business_address: settings.business_address || '',
    business_phone: settings.business_phone || '',
  }, content);

  return createContract({
    tenant_id: tenantId,
    lead_id: lead.id,
    quote_id: quote.id,
    title: `${jobLabel(lead.job_type || quote.job_type)} — Service Agreement`,
    scope_of_work: buildScopeOfWork(lead, quote),
    total_cents: content.total_cents,
    deposit_cents: depositCents,
    terms,
    customer_name: lead.name,
    customer_email: lead.email,
    job_address: jobAddress,
  });
}

/** Renders the full contract as one print-friendly HTML document. */
function renderContractHtml(contract, settings) {
  const biz = settings.business_name || 'CrewMind';
  const balanceCents = (contract.total_cents || 0) - (contract.deposit_cents || 0);
  const paragraphs = esc(contract.terms || '')
    .split(/\n{2,}/)
    .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');

  const signatureBlock = contract.status === 'signed'
    ? `<div class="sig">
         <h2>Electronic Signature</h2>
         <p>Signed by: <strong>${esc(contract.signed_name || '')}</strong> (typed signature: "${esc(contract.signature_text || '')}")</p>
         <p>Signed at: ${contract.signed_at ? new Date(contract.signed_at).toLocaleString('en-US') : ''}</p>
         <p>Signer IP: ${esc(contract.signer_ip || '')}</p>
         <p>Document SHA-256: <span class="mono">${esc(contract.document_sha256 || '')}</span></p>
       </div>`
    : `<div class="sig"><p><em>Unsigned copy — signature block is completed when the customer signs online.</em></p></div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${esc(contract.title || 'Service Agreement')} — ${esc(contract.contract_number || '')}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; color: #111; margin: 40px auto; max-width: 760px; padding: 0 20px; line-height: 1.55; }
  h1 { font-size: 22px; margin-bottom: 2px; }
  h2 { font-size: 16px; margin-top: 28px; border-bottom: 1px solid #999; padding-bottom: 4px; }
  .meta { color: #444; font-size: 14px; }
  .box { border: 1px solid #999; padding: 14px 18px; margin: 16px 0; white-space: pre-wrap; font-family: inherit; }
  .amounts td { padding: 4px 12px 4px 0; }
  .sig { border-top: 2px solid #111; margin-top: 36px; padding-top: 12px; }
  .mono { font-family: monospace; font-size: 12px; word-break: break-all; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
  <h1>${esc(contract.title || 'Service Agreement')}</h1>
  <p class="meta">Contract ${esc(contract.contract_number || '')} · ${esc(biz)}</p>

  <h2>Customer and Job</h2>
  <p>
    Customer: <strong>${esc(contract.customer_name || '')}</strong> (${esc(contract.customer_email || '')})<br>
    Job address: ${esc(contract.job_address || '')}
  </p>

  <h2>Scope of Work</h2>
  <div class="box">${esc(contract.scope_of_work || '')}</div>

  <h2>Price</h2>
  <table class="amounts">
    <tr><td>Total contract price</td><td><strong>${money(contract.total_cents)}</strong></td></tr>
    <tr><td>Deposit due on signing</td><td>${money(contract.deposit_cents)}</td></tr>
    <tr><td>Balance due on completion</td><td>${money(balanceCents)}</td></tr>
  </table>

  <h2>Terms and Conditions</h2>
  ${paragraphs}

  ${signatureBlock}
</body>
</html>`;
}

module.exports = {
  buildScopeOfWork,
  buildTerms,
  canonicalContractText,
  hashContract,
  getContractSignUrl,
  ensureContractForQuote,
  renderContractHtml,
  money,
  esc,
};
