/**
 * routes/admin.js
 * Owns: Admin dashboard API — lead pipeline, upcoming appointments, pricing rule management.
 * Does NOT own: auth (uses simple bearer token), email sending, DB layer details.
 *
 * Protected by ADMIN_TOKEN env var (set in Render dashboard).
 * Simple bearer token auth — good enough for an MVP internal tool.
 *
 * FAIL-CLOSED: if ADMIN_TOKEN is not set, admin routes return 503 instead of
 * serving data. An unconfigured deployment must never expose lead PII or
 * pricing controls just because an env var was forgotten.
 */

const express = require('express');
const router = express.Router();

const { getLeads, countLeads } = require('../db/leads');
const { getPricingRules, updatePricingRule } = require('../db/quotes');
const { getUpcomingAppointments, ensureUpcomingSlots } = require('../db/appointments');
const { getAllSettings, setSetting } = require('../db/settings');

// Settings the admin console may read/write. Values are stored as text in
// app_settings; deposit_percent is exposed as a number.
const EDITABLE_SETTINGS = ['deposit_percent', 'business_name', 'business_address', 'business_phone'];

async function readSettings() {
  const raw = await getAllSettings(1); // operator console = tenant 1
  const pct = parseInt(raw.deposit_percent, 10);
  return {
    deposit_percent: Number.isNaN(pct) ? 20 : pct,
    business_name: raw.business_name || 'CrewMind',
    business_address: raw.business_address || '',
    business_phone: raw.business_phone || '',
  };
}

// Simple token auth middleware — fails CLOSED when ADMIN_TOKEN is unset.
function requireAdmin(req, res, next) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    console.error('[admin] ADMIN_TOKEN not set — refusing admin request (503). Set ADMIN_TOKEN in the environment to enable admin routes.');
    return res.status(503).json({ error: 'Admin API is not configured on this server.' });
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
    const counts = await countLeads(1);
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
    const leads = await getLeads({ tenantId: 1, status, limit: parseInt(limit) || 50 });
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
    const appointments = await getUpcomingAppointments(1);
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
    const rules = await getPricingRules(1);
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
    const rule = await updatePricingRule(req.params.id, { base_price_cents, price_per_sqft_cents, notes }, 1);
    if (!rule) return res.status(404).json({ error: 'Pricing rule not found.' });
    res.json({ rule });
  } catch (err) {
    console.error('[admin] pricing update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/admin/settings
 * All editable app settings (deposit percent, business identity).
 */
router.get('/settings', async (req, res) => {
  try {
    res.json({ settings: await readSettings() });
  } catch (err) {
    console.error('[admin] settings read error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/admin/settings
 * Update a subset of editable settings. Unknown keys are ignored;
 * deposit_percent must be an integer 0–100.
 */
router.patch('/settings', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.deposit_percent !== undefined) {
      const pct = parseInt(body.deposit_percent, 10);
      if (Number.isNaN(pct) || pct < 0 || pct > 100) {
        return res.status(400).json({ error: 'deposit_percent must be an integer between 0 and 100.' });
      }
    }
    for (const key of EDITABLE_SETTINGS) {
      if (body[key] !== undefined) {
        await setSetting(key, key === 'deposit_percent' ? parseInt(body[key], 10) : String(body[key]), 1);
      }
    }
    res.json({ settings: await readSettings() });
  } catch (err) {
    console.error('[admin] settings update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/admin/slots/generate
 * Tops up booking availability for the next N business days (default 30,
 * 4 windows/day, max 2 bookings each). Idempotent — safe to re-run.
 * Body (all optional): { business_days, max_bookings }
 */
router.post('/slots/generate', async (req, res) => {
  try {
    const businessDays = parseInt(req.body?.business_days) || 30;
    const maxBookings = parseInt(req.body?.max_bookings) || 2;
    const result = await ensureUpcomingSlots({ tenantId: 1, businessDays, maxBookings });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[admin] slot generation error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
// Also used by server.js to protect the scraper endpoints, which live
// outside this router but carry the same sensitivity.
module.exports.requireAdmin = requireAdmin;
