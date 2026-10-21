/**
 * db/tenants.js
 * Owns: All database queries for the tenants table (migration 006).
 * Does NOT own: auth/session logic (lib/auth.js), Stripe subscription
 * calls (services/billing.js), HTTP handling (routes/).
 */

const pool = require('./index');

const OPERATOR_TENANT_ID = 1;

async function createTenant(data) {
  const {
    slug, business_name, owner_name, email, password_hash,
    status = 'trial', plan = 'core', billing_interval = null,
    founding_cohort = false, cohort_number = null, signup_campaign = null,
    trial_started_at = null, trial_ends_at = null,
  } = data;
  const result = await pool.query(
    `INSERT INTO tenants (
       slug, business_name, owner_name, email, password_hash, status, plan,
       billing_interval, founding_cohort, cohort_number, signup_campaign,
       trial_started_at, trial_ends_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [slug, business_name || null, owner_name || null, email || null, password_hash || null,
     status, plan, billing_interval, founding_cohort, cohort_number, signup_campaign,
     trial_started_at, trial_ends_at]
  );
  return result.rows[0];
}

async function getTenantById(id) {
  const result = await pool.query('SELECT * FROM tenants WHERE id=$1', [id]);
  return result.rows[0] || null;
}

async function getTenantBySlug(slug) {
  if (!slug) return null;
  const result = await pool.query('SELECT * FROM tenants WHERE slug=$1', [String(slug).toLowerCase()]);
  return result.rows[0] || null;
}

async function getTenantByEmail(email) {
  if (!email) return null;
  const result = await pool.query('SELECT * FROM tenants WHERE LOWER(email)=LOWER($1)', [email]);
  return result.rows[0] || null;
}

async function getTenantByStripeCustomerId(customerId) {
  if (!customerId) return null;
  const result = await pool.query('SELECT * FROM tenants WHERE stripe_customer_id=$1', [customerId]);
  return result.rows[0] || null;
}

async function getTenantBySubscriptionId(subscriptionId) {
  if (!subscriptionId) return null;
  const result = await pool.query('SELECT * FROM tenants WHERE stripe_subscription_id=$1', [subscriptionId]);
  return result.rows[0] || null;
}

/** Total tenants ever created (drives founding-cohort numbering). */
async function countTenants() {
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM tenants');
  return result.rows[0].count;
}

async function listTenants({ limit = 200 } = {}) {
  const result = await pool.query('SELECT * FROM tenants ORDER BY id ASC LIMIT $1', [limit]);
  return result.rows;
}

const UPDATABLE_FIELDS = [
  'business_name', 'owner_name', 'email', 'password_hash', 'status', 'plan',
  'billing_interval', 'founding_cohort', 'cohort_number', 'signup_campaign',
  'trial_started_at', 'trial_ends_at', 'stripe_customer_id',
  'stripe_subscription_id', 'subscription_status', 'current_period_end',
  'onboarding_completed_at', 'payout_connected', 'payout_skipped',
  'is_comped', 'comped_at',
];

async function updateTenant(id, fields) {
  const keys = Object.keys(fields || {}).filter(k => UPDATABLE_FIELDS.includes(k));
  if (!keys.length) return getTenantById(id);
  const sets = keys.map((k, i) => `${k}=$${i + 1}`);
  const values = keys.map(k => fields[k]);
  const result = await pool.query(
    `UPDATE tenants SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${keys.length + 1} RETURNING *`,
    [...values, id]
  );
  return result.rows[0] || null;
}

/**
 * Grant or revoke a lifetime comp (migration 012). The comp is an overlay:
 * ONLY is_comped/comped_at change here — the tenant's stored status is
 * never rewritten, so revoking restores exactly the state their trial or
 * subscription dictates.
 */
async function setTenantComp(id, comped) {
  return updateTenant(id, comped
    ? { is_comped: true, comped_at: new Date().toISOString() }
    : { is_comped: false, comped_at: null });
}

/**
 * The status the rest of the app should act on. A trial whose end date has
 * passed behaves as locked even if no job has flipped the stored status
 * yet — expiry is computed, not cron-dependent.
 *
 * A comped tenant (is_comped) is always 'active': the comp overlays the
 * stored status and the trial clock without ever modifying them.
 */
function effectiveStatus(tenant) {
  if (!tenant) return 'locked';
  if (tenant.is_operator) return 'active';
  if (tenant.is_comped) return 'active';
  if (tenant.status === 'trial' && tenant.trial_ends_at && new Date(tenant.trial_ends_at) < new Date()) {
    return 'locked';
  }
  return tenant.status;
}

function isLocked(tenant) {
  const s = effectiveStatus(tenant);
  return s === 'locked' || s === 'canceled';
}

/** Public-safe view of a tenant (never leaks the password hash). */
function publicTenant(tenant) {
  if (!tenant) return null;
  const { password_hash, ...rest } = tenant;
  return { ...rest, effective_status: effectiveStatus(tenant) };
}

const TRIAL_DAYS = 14;

async function countNonOperatorTenants() {
  const result = await pool.query(
    'SELECT COUNT(*)::int AS count FROM tenants WHERE is_operator = FALSE'
  );
  return result.rows[0].count;
}

module.exports = {
  OPERATOR_TENANT_ID,
  TRIAL_DAYS,
  createTenant, getTenantById, getTenantBySlug, getTenantByEmail,
  getTenantByStripeCustomerId, getTenantBySubscriptionId,
  countTenants, countNonOperatorTenants, listTenants, updateTenant,
  setTenantComp, effectiveStatus, isLocked, publicTenant,
};
