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
const { listTenants, getTenantById, setTenantComp, effectiveStatus } = require('../db/tenants');
const phoneDb = require('../db/phone');
const { normalizePhone } = require('../lib/phone-routing');

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

/** Shape one tenant for the operator console (never the password hash). */
function adminTenantView(t) {
  return {
    id: t.id,
    business_name: t.business_name,
    email: t.email,
    status: t.status,
    effective_status: effectiveStatus(t),
    is_comped: !!t.is_comped,
    comped_at: t.comped_at || null,
    founding_cohort: !!t.founding_cohort,
    cohort_number: t.cohort_number,
    plan: t.plan,
    is_operator: !!t.is_operator,
    created_at: t.created_at,
  };
}

/**
 * GET /api/admin/tenants
 * All tenant accounts with stored + effective status and comp state.
 */
router.get('/tenants', async (req, res) => {
  try {
    const tenants = await listTenants({});
    res.json({ tenants: tenants.map(adminTenantView) });
  } catch (err) {
    console.error('[admin] tenants list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/admin/tenants/:id/comp
 * Grant a lifetime comp. Overlay only — the stored status is untouched,
 * so the tenant is active immediately (even mid- or post-trial) and a
 * later uncomp restores their real trial/subscription state.
 */
router.post('/tenants/:id/comp', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const tenant = Number.isNaN(id) ? null : await getTenantById(id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });
    const updated = await setTenantComp(tenant.id, true);
    res.json({ tenant: adminTenantView(updated) });
  } catch (err) {
    console.error('[admin] comp grant error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/admin/tenants/:id/uncomp
 * Revoke a lifetime comp. The tenant returns to whatever their stored
 * status / trial clock / subscription says — nothing was ever rewritten.
 */
router.post('/tenants/:id/uncomp', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const tenant = Number.isNaN(id) ? null : await getTenantById(id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });
    const updated = await setTenantComp(tenant.id, false);
    res.json({ tenant: adminTenantView(updated) });
  } catch (err) {
    console.error('[admin] comp revoke error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * -- Phone module (Phase 10) ------------------------------------------------
 * Operator-console management for the tenant-1 phone routing: settings,
 * the personal pass-through list, the ring-through toggle, and the
 * recent call log. The webhooks themselves live in routes/phone.js and
 * stay inert until Twilio env vars are set on the server.
 */

function phoneSettingsView(s) {
  const until = s.ringThroughUntil ? new Date(s.ringThroughUntil) : null;
  return {
    enabled: !!s.enabled,
    owner_number: s.ownerNumber || '',
    greeting_name: s.greetingName || '',
    phone_number: s.phoneNumber || '',
    after_hours: !!s.afterHours,
    ringthrough_until: s.ringThroughUntil || null,
    ringthrough_active: !!(until && !Number.isNaN(until.getTime()) && until.getTime() > Date.now()),
  };
}

/**
 * GET /api/admin/phone
 * Everything the console Phone section needs in one read.
 */
router.get('/phone', async (req, res) => {
  try {
    const [settings, contacts, calls] = await Promise.all([
      phoneDb.getPhoneSettings(1),
      phoneDb.listPersonalContacts(1),
      phoneDb.listCallLog(1, 25),
    ]);
    res.json({ settings: phoneSettingsView(settings), contacts, calls });
  } catch (err) {
    console.error('[admin] phone read error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/admin/phone/settings
 * Update phone settings. Phone numbers are stored normalized (E.164);
 * a non-empty number that can't be normalized is a 400.
 */
router.patch('/phone/settings', async (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};
    if (body.enabled !== undefined) patch.enabled = !!body.enabled;
    if (body.after_hours !== undefined) patch.afterHours = !!body.after_hours;
    if (body.greeting_name !== undefined) patch.greetingName = String(body.greeting_name).trim();
    for (const [field, key] of [['owner_number', 'ownerNumber'], ['phone_number', 'phoneNumber']]) {
      if (body[field] !== undefined) {
        const raw = String(body[field]).trim();
        if (raw && !normalizePhone(raw)) {
          return res.status(400).json({ error: `${field} doesn't look like a valid phone number.` });
        }
        patch[key] = raw;
      }
    }
    const settings = await phoneDb.updatePhoneSettings(1, patch);
    res.json({ settings: phoneSettingsView(settings) });
  } catch (err) {
    console.error('[admin] phone settings update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/admin/phone/ringthrough
 * Flip the line to ring-through mode for 30 minutes (owner is
 * expecting a personal call — every call rings them directly).
 */
router.post('/phone/ringthrough', async (req, res) => {
  try {
    const until = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const settings = await phoneDb.updatePhoneSettings(1, { ringThroughUntil: until });
    res.json({ settings: phoneSettingsView(settings) });
  } catch (err) {
    console.error('[admin] phone ringthrough set error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /api/admin/phone/ringthrough — turn ring-through mode off now. */
router.delete('/phone/ringthrough', async (req, res) => {
  try {
    const settings = await phoneDb.updatePhoneSettings(1, { ringThroughUntil: null });
    res.json({ settings: phoneSettingsView(settings) });
  } catch (err) {
    console.error('[admin] phone ringthrough clear error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/admin/phone/contacts — add a personal pass-through contact. */
router.post('/phone/contacts', async (req, res) => {
  try {
    const name = String((req.body || {}).name || '').trim();
    const phoneE164 = normalizePhone((req.body || {}).phone);
    if (!name) return res.status(400).json({ error: 'A name is required.' });
    if (!phoneE164) return res.status(400).json({ error: "That phone number doesn't look valid." });
    const contact = await phoneDb.addPersonalContact(1, { name, phoneE164 });
    res.json({ contact });
  } catch (err) {
    console.error('[admin] phone contact add error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /api/admin/phone/contacts/:id */
router.delete('/phone/contacts/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const removed = Number.isNaN(id) ? false : await phoneDb.deletePersonalContact(1, id);
    if (!removed) return res.status(404).json({ error: 'Contact not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('[admin] phone contact delete error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
// Also used by server.js to protect the scraper endpoints, which live
// outside this router but carry the same sensitivity.
module.exports.requireAdmin = requireAdmin;
