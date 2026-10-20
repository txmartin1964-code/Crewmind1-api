/**
 * lib/auth.js
 * Owns: Tenant password hashing (bcrypt) and tenant session tokens (JWT),
 * plus the requireTenant middleware used by every tenant-console route.
 * Does NOT own: the platform-operator ADMIN_TOKEN auth (routes/admin.js,
 * unchanged from Phase 1) or tenant CRUD (db/tenants.js).
 *
 * Env:
 *   JWT_SECRET - signing secret for tenant session tokens. If unset, a
 *     random per-boot secret is generated and a warning is logged —
 *     sessions then do not survive a server restart. Set JWT_SECRET in
 *     production.
 */

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getTenantById, effectiveStatus, isLocked } = require('../db/tenants');

const TOKEN_TTL = '7d';
const SALT_ROUNDS = 10;

let cachedSecret = null;
function getJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (!cachedSecret) {
    cachedSecret = crypto.randomBytes(32).toString('hex');
    console.warn('[auth] JWT_SECRET is not set — generated a per-boot secret. Tenant sessions will not survive a restart. Set JWT_SECRET in the environment.');
  }
  return cachedSecret;
}

async function hashPassword(plain) {
  return bcrypt.hash(String(plain), SALT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  try {
    return await bcrypt.compare(String(plain), hash);
  } catch {
    return false;
  }
}

function signTenantToken(tenant) {
  return jwt.sign(
    { sub: String(tenant.id), slug: tenant.slug, email: tenant.email },
    getJwtSecret(),
    { expiresIn: TOKEN_TTL }
  );
}

function verifyTenantToken(token) {
  return jwt.verify(token, getJwtSecret());
}

function extractBearer(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : null;
}

/**
 * Express middleware: requires a valid tenant session token. Loads the
 * tenant row fresh from the DB (so status changes apply immediately) and
 * attaches req.tenant / req.tenantId.
 */
async function requireTenant(req, res, next) {
  try {
    const token = extractBearer(req);
    if (!token) return res.status(401).json({ error: 'Sign in required.' });
    let payload;
    try {
      payload = verifyTenantToken(token);
    } catch {
      return res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
    }
    const tenant = await getTenantById(parseInt(payload.sub, 10));
    if (!tenant) return res.status(401).json({ error: 'Account not found.' });
    req.tenant = tenant;
    req.tenantId = tenant.id;
    req.tenantStatus = effectiveStatus(tenant);
    next();
  } catch (err) {
    console.error('[auth] requireTenant error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

/**
 * Middleware (after requireTenant): blocks MUTATING requests when the
 * tenant is locked (trial expired / subscription canceled). Reads stay
 * available so a locked tenant can see their data and reach the billing
 * endpoints to fix it. Billing/onboarding routes opt out by not using it.
 */
function blockWritesWhenLocked(req, res, next) {
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  if (mutating && isLocked(req.tenant)) {
    return res.status(402).json({
      error: 'Your CrewMind trial or subscription is not active. Upgrade to Core to make changes.',
      code: 'subscription_required',
      tenant_status: req.tenantStatus,
    });
  }
  next();
}

module.exports = {
  hashPassword, verifyPassword,
  signTenantToken, verifyTenantToken,
  requireTenant, blockWritesWhenLocked,
};
