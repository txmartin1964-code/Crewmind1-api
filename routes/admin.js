/**
 * routes/admin.js
 * Owns: Admin dashboard API — lead pipeline, upcoming appointments, pricing rule management.
 * Does NOT own: auth (uses simple bearer token), email sending, DB layer details.
 *
 * Protected by ADMIN_TOKEN env var (set in Render dashboard).
 * Simple bearer token auth — good enough for an MVP internal tool.
 */

const express = require('express');
const router = express.Router();

const { getLeads, countLeads } = require('../db/leads');
const { getPricingRules, updatePricingRule } = require('../db/quotes');
const { getUpcomingAppointments } = require('../db/appointments');

// Simple token auth middleware
function requireAdmin(req, res, next) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    // No token set — allow access in dev (warn loudly in prod)
    console.warn('[admin] ADMIN_TOKEN not set — admin routes unprotected!');
    return next();
  }
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (token !== adminToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(requireAdmin);

/**
 * GET /api/admin/stats
 * 30-day pipeline summary.
 */
router.get('/stats', async (req, res) => {
  try {
    const counts = await countLeads();
    res.json({ stats: counts });
  } catch (err) {
    console.error('[admin] stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/admin/leads?status=new|qualified|booked|disqualified&limit=50
 * List leads with optional status filter.
 */
router.get('/leads', async (req, res) => {
  try {
    const { status, limit } = req.query;
    const leads = await getLeads({ status, limit: parseInt(limit) || 50 });
    res.json({ leads });
  } catch (err) {
    console.error('[admin] leads error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/admin/appointments
 * Upcoming confirmed appointments.
 */
router.get('/appointments', async (req, res) => {
  try {
    const appointments = await getUpcomingAppointments();
    res.json({ appointments });
  } catch (err) {
    console.error('[admin] appointments error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/admin/pricing
 * All pricing rules.
 */
router.get('/pricing', async (req, res) => {
  try {
    const rules = await getPricingRules();
    res.json({ rules });
  } catch (err) {
    console.error('[admin] pricing error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/admin/pricing/:id
 * Update a pricing rule's base price, sqft rate, or notes.
 */
router.patch('/pricing/:id', async (req, res) => {
  try {
    const { base_price_cents, price_per_sqft_cents, notes } = req.body;
    const rule = await updatePricingRule(req.params.id, { base_price_cents, price_per_sqft_cents, notes });
    if (!rule) return res.status(404).json({ error: 'Pricing rule not found.' });
    res.json({ rule });
  } catch (err) {
    console.error('[admin] pricing update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
