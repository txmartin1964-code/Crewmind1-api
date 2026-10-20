/**
 * routes/contracts.js
 * Owns: HTTP handling for contracts — public signing page API and the
 * admin contracts API.
 * Does NOT own: contract content (services/contracts.js), DB writes
 * (db/contracts.js), email transport (services/email.js).
 *
 * Two routers:
 *   publicRouter — mounted at /api/contracts. Reached via the unguessable
 *     access token (never the serial id): view summary, the rendered
 *     document, and the sign action.
 *   adminRouter — mounted at /api/admin/contracts behind requireAdmin:
 *     list, detail, create-from-quote, send, void, document, PDF.
 */

const express = require('express');

const {
  getContractById, getContractByToken, getContracts, updateContractStatus, markContractSigned,
} = require('../db/contracts');
const { getQuoteById } = require('../db/quotes');
const { getLeadById } = require('../db/leads');
const { getAllSettings } = require('../db/settings');
const {
  ensureContractForQuote, renderContractHtml, hashContract, getContractSignUrl,
} = require('../services/contracts');
const { sendContractLink } = require('../services/email');
const {
  isStripeConfigured, getPaymentLinkUrl,
} = require('../services/payments');
const { requireAdmin } = require('./admin');

// ---------------- Public (customer) routes ----------------

const publicRouter = express.Router();

function publicSummary(contract) {
  return {
    contract_number: contract.contract_number,
    title: contract.title,
    status: contract.status,
    customer_name: contract.customer_name,
    total_cents: contract.total_cents,
    deposit_cents: contract.deposit_cents,
    signed_name: contract.signed_name,
    signed_at: contract.signed_at,
  };
}

publicRouter.get('/view/:token', async (req, res) => {
  try {
    const contract = await getContractByToken(req.params.token);
    if (!contract) return res.status(404).json({ error: 'Contract not found.' });
    res.json({ contract: publicSummary(contract) });
  } catch (err) {
    console.error('[contracts] view error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

publicRouter.get('/document/:token', async (req, res) => {
  try {
    const contract = await getContractByToken(req.params.token);
    if (!contract) return res.status(404).send('Contract not found.');
    const settings = await getAllSettings(contract.tenant_id || 1);
    res.type('html').send(renderContractHtml(contract, settings));
  } catch (err) {
    console.error('[contracts] document error:', err);
    res.status(500).send('Server error');
  }
});

publicRouter.post('/view/:token/sign', async (req, res) => {
  try {
    const contract = await getContractByToken(req.params.token);
    if (!contract) return res.status(404).json({ error: 'Contract not found.' });

    if (contract.status === 'signed') {
      return res.status(409).json({ error: 'This contract has already been signed.' });
    }
    if (contract.status === 'void') {
      return res.status(409).json({ error: 'This contract has been voided.' });
    }
    if (contract.status !== 'sent') {
      return res.status(409).json({ error: 'This contract is not ready for signature yet.' });
    }

    const signedName = String(req.body?.signed_name || '').trim();
    const agreed = req.body?.agree === true || req.body?.agree === 'true';
    if (!agreed) {
      return res.status(400).json({ error: 'You must check the "I agree" box to sign.' });
    }
    if (signedName.length < 2) {
      return res.status(400).json({ error: 'Please type your full legal name to sign.' });
    }

    // Hash the contract exactly as stored, before recording the signature,
    // so the hash proves what content was agreed to.
    const documentSha256 = hashContract(contract);

    const signed = await markContractSigned(contract.id, {
      signedName,
      signatureText: signedName,
      signerIp: req.ip || '',
      signerUserAgent: req.headers['user-agent'] || '',
      documentSha256,
    });
    if (!signed) {
      // Lost a race (status changed between read and write).
      return res.status(409).json({ error: 'This contract could not be signed. It may have already been signed or voided.' });
    }

    console.log(`[contracts] contract ${contract.contract_number} signed by "${signedName}" from ${req.ip}. sha256=${documentSha256}`);
    res.json({ success: true, contract: publicSummary(signed) });
  } catch (err) {
    console.error('[contracts] sign error:', err);
    res.status(500).json({ error: 'Signing failed. Please try again.' });
  }
});

// ---------------- Admin routes ----------------

const adminRouter = express.Router();
adminRouter.use(requireAdmin);

adminRouter.get('/', async (req, res) => {
  try {
    const contracts = await getContracts({ tenantId: 1, limit: parseInt(req.query.limit) || 100 });
    res.json({ contracts });
  } catch (err) {
    console.error('[contracts] admin list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

adminRouter.get('/:id', async (req, res) => {
  try {
    const contract = await getContractById(req.params.id);
    if (!contract) return res.status(404).json({ error: 'Contract not found.' });
    res.json({ contract, sign_url: getContractSignUrl(contract) });
  } catch (err) {
    console.error('[contracts] admin detail error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/admin/contracts  { quote_id }
 * Creates a draft contract for a quote (idempotent — returns the existing
 * non-void contract for that quote if one exists).
 */
adminRouter.post('/', async (req, res) => {
  try {
    const quoteId = parseInt(req.body?.quote_id, 10);
    if (!quoteId) return res.status(400).json({ error: 'quote_id is required.' });
    const quote = await getQuoteById(quoteId);
    if (!quote) return res.status(404).json({ error: 'Quote not found.' });
    const lead = await getLeadById(quote.lead_id);
    if (!lead) return res.status(404).json({ error: 'Lead not found for this quote.' });
    const contract = await ensureContractForQuote(lead, quote);
    res.json({ contract, sign_url: getContractSignUrl(contract) });
  } catch (err) {
    console.error('[contracts] admin create error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/admin/contracts/:id/send
 * Emails the customer the signing link and marks the contract 'sent' —
 * only when the email actually went out (same honesty pattern as quotes).
 */
adminRouter.post('/:id/send', async (req, res) => {
  try {
    const contract = await getContractById(req.params.id);
    if (!contract) return res.status(404).json({ error: 'Contract not found.' });
    if (contract.status === 'signed') return res.status(409).json({ error: 'Contract is already signed.' });
    if (contract.status === 'void') return res.status(409).json({ error: 'Contract is void.' });

    const signUrl = getContractSignUrl(contract);

    let payment = null;
    if (isStripeConfigured() && contract.deposit_cents > 0) {
      const quote = await getQuoteById(contract.quote_id);
      if (quote && quote.payment_status === 'unpaid') {
        payment = { url: getPaymentLinkUrl(contract.quote_id), deposit_cents: contract.deposit_cents };
      }
    }

    const emailResult = await sendContractLink(contract, signUrl, payment);
    if (!emailResult || !emailResult.ok) {
      console.error(`[contracts] contract email NOT sent for contract ${contract.contract_number} (id ${contract.id}) — email service reported failure. Status left as '${contract.status}'.`);
      return res.status(502).json({ error: 'Email service failed to send the contract link. Contract was not marked sent.' });
    }

    const updated = contract.status === 'sent' ? contract : await updateContractStatus(contract.id, 'sent');
    res.json({ contract: updated, sign_url: signUrl });
  } catch (err) {
    console.error('[contracts] admin send error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/admin/contracts/:id/void
 * Voids a draft/sent contract. Signed contracts are locked and cannot be
 * voided through the API.
 */
adminRouter.post('/:id/void', async (req, res) => {
  try {
    const contract = await getContractById(req.params.id);
    if (!contract) return res.status(404).json({ error: 'Contract not found.' });
    if (contract.status === 'signed') {
      return res.status(409).json({ error: 'A signed contract cannot be voided.' });
    }
    if (contract.status === 'void') {
      return res.status(409).json({ error: 'Contract is already void.' });
    }
    const updated = await updateContractStatus(contract.id, 'void');
    res.json({ contract: updated });
  } catch (err) {
    console.error('[contracts] admin void error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

adminRouter.get('/:id/document', async (req, res) => {
  try {
    const contract = await getContractById(req.params.id);
    if (!contract) return res.status(404).send('Contract not found.');
    const settings = await getAllSettings(contract.tenant_id || 1);
    res.type('html').send(renderContractHtml(contract, settings));
  } catch (err) {
    console.error('[contracts] admin document error:', err);
    res.status(500).send('Server error');
  }
});

/**
 * GET /api/admin/contracts/:id/pdf
 * Renders the contract document to PDF with Puppeteer. If Puppeteer or
 * Chrome is unavailable in the environment, returns 500 with a pointer
 * to the print-friendly document page instead.
 */
adminRouter.get('/:id/pdf', async (req, res) => {
  let browser;
  try {
    const contract = await getContractById(req.params.id);
    if (!contract) return res.status(404).json({ error: 'Contract not found.' });
    const settings = await getAllSettings(contract.tenant_id || 1);
    const html = renderContractHtml(contract, settings);

    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'Letter', printBackground: true });
    await browser.close();
    browser = null;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="contract-${contract.contract_number}.pdf"`);
    return res.send(pdf);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[contracts] PDF generation failed:', err.message);
    return res.status(500).json({
      error: 'PDF generation is unavailable in this environment. Open the document view and print to PDF instead.',
      document_url: `/api/admin/contracts/${req.params.id}/document`,
    });
  }
});

module.exports = { publicRouter, adminRouter };
