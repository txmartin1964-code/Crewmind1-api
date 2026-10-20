/**
 * routes/signup.js
 * Owns: Public self-serve signup (POST /api/signup).
 * Does NOT own: tenant auth (routes/auth.js), billing (routes/billing.js),
 * onboarding (routes/onboarding.js).
 *
 * A signup creates a tenant in 'trial' status for 14 days, no card.
 * The first 100 non-operator tenants form the founding cohort: their
 * Core rate is locked at $119/mo for 12 months (cohort number recorded
 * on the tenant). Signup also seeds the tenant's default pricing rules,
 * base settings, and booking availability so onboarding (Item 3) starts
 * from a working account.
 */

const express = require('express');
const router = express.Router();

const { hashPassword, signTenantToken } = require('../lib/auth');
const {
  createTenant, getTenantByEmail, getTenantBySlug,
  countNonOperatorTenants, publicTenant, TRIAL_DAYS,
} = require('../db/tenants');
const { seedPricingRulesForTenant } = require('../db/quotes');
const { ensureUpcomingSlots } = require('../db/appointments');
const { setSetting } = require('../db/settings');

const FOUNDING_COHORT_SIZE = 100;

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'business';
}

async function uniqueSlug(base) {
  let slug = base;
  let n = 2;
  while (await getTenantBySlug(slug)) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

router.post('/', async (req, res) => {
  try {
    const { business_name, owner_name, email, password, campaign } = req.body || {};

    if (!business_name || !String(business_name).trim()) {
      return res.status(400).json({ error: 'Business name is required.' });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    if (await getTenantByEmail(email)) {
      return res.status(409).json({ error: 'An account with this email already exists. Try logging in.' });
    }

    const existing = await countNonOperatorTenants();
    const cohortNumber = existing + 1;
    const founding = cohortNumber <= FOUNDING_COHORT_SIZE;

    const now = new Date();
    const trialEnds = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    const tenant = await createTenant({
      slug: await uniqueSlug(slugify(business_name)),
      business_name: String(business_name).trim(),
      owner_name: owner_name ? String(owner_name).trim() : null,
      email: String(email).toLowerCase().trim(),
      password_hash: await hashPassword(password),
      status: 'trial',
      founding_cohort: founding,
      cohort_number: cohortNumber,
      signup_campaign: campaign ? String(campaign).slice(0, 100) : null,
      trial_started_at: now.toISOString(),
      trial_ends_at: trialEnds.toISOString(),
    });

    // Seed everything the new business needs to operate from minute one.
    await seedPricingRulesForTenant(tenant.id);
    await setSetting('business_name', tenant.business_name, tenant.id);
    await setSetting('deposit_percent', '20', tenant.id);
    await ensureUpcomingSlots({ tenantId: tenant.id }).catch(err =>
      console.error('[signup] slot seeding failed (non-fatal):', err.message)
    );

    // Close the GTM loop: if this signup's email is one of the
    // operator's scraped prospects, move that prospect to 'trial'.
    try {
      const gtm = require('../db/gtm');
      const prospect = await gtm.findProspectByEmail(tenant.email, 1);
      if (prospect && (prospect.pipeline_status === 'new' || prospect.pipeline_status === 'contacted')) {
        await gtm.updateProspectStatus(prospect.id, 'trial', 1);
      }
    } catch (gtmErr) {
      console.error('[signup] prospect attribution failed (non-fatal):', gtmErr.message);
    }

    const token = signTenantToken(tenant);
    res.status(201).json({ token, tenant: publicTenant(tenant) });
  } catch (err) {
    console.error('[signup] error:', err);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

module.exports = router;
