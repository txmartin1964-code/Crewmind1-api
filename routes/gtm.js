/**
 * routes/gtm.js
 * Owns: GTM engine HTTP handling.
 *   adminRouter  (mounted at /api/admin, ADMIN_TOKEN):
 *     GET   /prospects                 pipeline list + counts
 *     PATCH /prospects/:id             move a prospect in the pipeline
 *     DELETE /prospects/:id            permanently remove a prospect
 *     GET   /campaigns                 campaigns with send tallies
 *     POST  /campaigns                 create a campaign (draft)
 *     POST  /campaigns/:id/send        send/resume (CAN-SPAM enforced)
 *     GET   /suppressions              the suppression list
 *     POST  /suppressions              manually suppress an email
 *   publicRouter (mounted at /api/gtm):
 *     GET/POST /unsubscribe            one-click unsubscribe (signed)
 */

const express = require('express');
const gtm = require('../db/gtm');
const { requireAdmin } = require('./admin');
const campaignsSvc = require('../services/campaigns');

const adminRouter = express.Router();
adminRouter.use(requireAdmin);

adminRouter.get('/prospects', async (req, res) => {
  try {
    const [prospects, counts] = await Promise.all([
      gtm.getProspects({
        tenantId: 1,
        status: req.query.status || undefined,
        onlyWithEmail: req.query.with_email === '1',
        limit: parseInt(req.query.limit, 10) || 100,
        offset: parseInt(req.query.offset, 10) || 0,
      }),
      gtm.getProspectCounts(1),
    ]);
    res.json({ prospects, counts });
  } catch (err) {
    console.error('[gtm] prospects error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

adminRouter.patch('/prospects/:id', async (req, res) => {
  try {
    const { pipeline_status } = req.body || {};
    if (!gtm.PIPELINE_STATUSES.includes(pipeline_status)) {
      return res.status(400).json({ error: `pipeline_status must be one of: ${gtm.PIPELINE_STATUSES.join(', ')}` });
    }
    const prospect = await gtm.updateProspectStatus(req.params.id, pipeline_status, 1);
    if (!prospect) return res.status(404).json({ error: 'Prospect not found.' });
    res.json({ prospect });
  } catch (err) {
    console.error('[gtm] prospect update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

adminRouter.delete('/prospects/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'A numeric prospect id is required.' });
    const deleted = await gtm.deleteProspect(id, 1);
    if (!deleted) return res.status(404).json({ error: 'Prospect not found.' });
    res.json({ ok: true, deleted: { id: deleted.id, name: deleted.name } });
  } catch (err) {
    console.error('[gtm] prospect delete error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

adminRouter.get('/campaigns', async (req, res) => {
  try {
    res.json({ campaigns: await gtm.getCampaigns(1) });
  } catch (err) {
    console.error('[gtm] campaigns error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

adminRouter.post('/campaigns', async (req, res) => {
  try {
    const { name, subject, body_text } = req.body || {};
    if (!name || !subject || !body_text) {
      return res.status(400).json({ error: 'name, subject, and body_text are required.' });
    }
    const campaign = await gtm.createCampaign({ tenant_id: 1, name, subject, body_text });
    res.status(201).json({ campaign, trial_url: campaignsSvc.getTrialUrl(campaign) });
  } catch (err) {
    console.error('[gtm] campaign create error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

adminRouter.post('/campaigns/:id/send', async (req, res) => {
  try {
    const campaign = await gtm.getCampaignById(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
    const limit = parseInt(req.body?.limit, 10) || 500;
    const tally = await campaignsSvc.sendCampaign(campaign, { limit });
    res.json({ ok: true, tally });
  } catch (err) {
    console.error('[gtm] campaign send error:', err);
    res.status(400).json({ error: err.message || 'Send failed.' });
  }
});

adminRouter.get('/suppressions', async (req, res) => {
  try {
    res.json({ suppressions: await gtm.listSuppressions() });
  } catch (err) {
    console.error('[gtm] suppressions error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

adminRouter.post('/suppressions', async (req, res) => {
  try {
    const { email, reason } = req.body || {};
    if (!email || !String(email).includes('@')) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    await gtm.addSuppression(email, reason || 'manual');
    res.json({ ok: true });
  } catch (err) {
    console.error('[gtm] suppression add error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------------- Public unsubscribe ---------------- */

const publicRouter = express.Router();

async function unsubscribeHandler(req, res) {
  const email = (req.query.e || req.body?.e || '').toString();
  const sig = (req.query.s || req.body?.s || '').toString();
  if (!campaignsSvc.verifyUnsubscribe(email, sig)) {
    return res.status(400).type('html').send(
      '<h1>Link not valid</h1><p>This unsubscribe link is incomplete or expired. Reply to any of our emails and we will remove you manually.</p>'
    );
  }
  await gtm.addSuppression(email, 'unsubscribe');
  // If the address belongs to a prospect, that is recorded by the
  // suppression check at send time — no status change needed here.
  return res.type('html').send(
    `<h1>You're unsubscribed</h1><p>${email.replace(/</g, '&lt;')} will not receive marketing email from CrewMind again. ` +
    'If you start a free trial later, you will still get account emails about your own business.</p>'
  );
}

publicRouter.get('/unsubscribe', unsubscribeHandler);
publicRouter.post('/unsubscribe', unsubscribeHandler);

module.exports = { adminRouter, publicRouter };
