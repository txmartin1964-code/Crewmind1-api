/**
 * routes/change-orders.js
 * Owns: Public customer-facing change-order approval — the token-link
 * twin of routes/contracts.js. The customer views the document, then
 * approves (typed-name e-sign) or declines. Approval is what makes the
 * amount count toward the final invoice.
 */

const express = require('express');
const router = express.Router();

const {
  getChangeOrderByToken, markChangeOrderSigned, markChangeOrderDeclined,
} = require('../db/change-orders');
const { getJobById, logJobEvent } = require('../db/jobs');
const { getLeadById } = require('../db/leads');
const { getAllSettings } = require('../db/settings');
const { changeOrderDocumentText, hashChangeOrder } = require('../services/change-orders');

async function loadContext(co) {
  const job = await getJobById(co.job_id);
  const lead = job && job.lead_id ? await getLeadById(job.lead_id) : null;
  const settings = await getAllSettings(co.tenant_id);
  return { job, lead, settings };
}

function publicView(co, document) {
  return {
    id: co.id,
    description: co.description,
    amount_cents: co.amount_cents,
    status: co.status,
    signed_name: co.signed_name,
    signed_at: co.signed_at,
    token_expires_at: co.token_expires_at,
    document,
  };
}

router.get('/view/:token', async (req, res) => {
  try {
    const co = await getChangeOrderByToken(req.params.token);
    if (!co) return res.status(404).json({ error: 'Change order not found.' });
    const { job, lead, settings } = await loadContext(co);
    res.json({ change_order: publicView(co, changeOrderDocumentText(co, job || {}, lead, settings)) });
  } catch (err) {
    console.error('[change-orders] view error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/view/:token/sign', async (req, res) => {
  try {
    const co = await getChangeOrderByToken(req.params.token);
    if (!co) return res.status(404).json({ error: 'Change order not found.' });
    if (co.status === 'approved') return res.status(409).json({ error: 'This change order has already been approved.' });
    if (co.status !== 'pending') return res.status(409).json({ error: `This change order is ${co.status} and can no longer be signed.` });
    if (co.token_expires_at && new Date(co.token_expires_at) < new Date()) {
      return res.status(410).json({ error: 'This approval link has expired. Ask the business to resend it.' });
    }
    const signedName = String(req.body?.signed_name || '').trim();
    if (!req.body?.agree) return res.status(400).json({ error: 'You must check the "I agree" box to approve.' });
    if (signedName.length < 2) return res.status(400).json({ error: 'Please type your full legal name to sign.' });

    const { job, lead, settings } = await loadContext(co);
    const signatureHash = hashChangeOrder(co, job || {}, lead, settings);
    const signed = await markChangeOrderSigned(co.id, {
      signedName, signatureHash, signerIp: req.ip || '',
    });
    if (!signed) return res.status(409).json({ error: 'This change order was just handled. Refresh to see its status.' });

    await logJobEvent(co.job_id, co.tenant_id, 'change_order_approved', {
      change_order_id: co.id, amount_cents: co.amount_cents, signed_name: signedName,
    });
    res.json({ ok: true, change_order: publicView(signed) });
  } catch (err) {
    console.error('[change-orders] sign error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/view/:token/decline', async (req, res) => {
  try {
    const co = await getChangeOrderByToken(req.params.token);
    if (!co) return res.status(404).json({ error: 'Change order not found.' });
    if (co.status !== 'pending') return res.status(409).json({ error: `This change order is ${co.status}.` });
    const declined = await markChangeOrderDeclined(co.id);
    if (!declined) return res.status(409).json({ error: 'This change order was just handled.' });
    await logJobEvent(co.job_id, co.tenant_id, 'change_order_declined', {
      change_order_id: co.id, amount_cents: co.amount_cents,
    });
    res.json({ ok: true, change_order: publicView(declined) });
  } catch (err) {
    console.error('[change-orders] decline error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
