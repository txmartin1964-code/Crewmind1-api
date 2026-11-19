/**
 * routes/auth.js
 * Owns: Tenant authentication endpoints (login, forgot-password,
 * reset-password). Signup lives in routes/signup.js; this file only
 * turns valid credentials into a session token, and runs the
 * password-reset flow for tenants who forgot theirs.
 * Does NOT own: password hashing / token mechanics (lib/auth.js),
 * reset-token rules (lib/password-reset.js), reset-token persistence
 * (db/password-reset.js), tenant CRUD (db/tenants.js), or email
 * sending (services/email.js).
 */

const express = require('express');
const router = express.Router();

const { getTenantByEmail, updateTenant, publicTenant } = require('../db/tenants');
const { verifyPassword, hashPassword, signTenantToken } = require('../lib/auth');
const {
  generateToken, hashToken, tokenExpiresAt, isTokenUsable,
  validateResetRequest, buildResetUrl,
  INVALID_LINK_MESSAGE, GENERIC_FORGOT_MESSAGE,
} = require('../lib/password-reset');
const {
  createResetToken, getResetTokenByHash, markResetTokenUsed,
  invalidateUnusedTokens,
} = require('../db/password-reset');
const { sendPasswordResetEmail } = require('../services/email');

router.post('/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const tenant = await getTenantByEmail(email);
    // Same message for unknown email and wrong password — don't leak
    // which accounts exist.
    if (!tenant || !tenant.password_hash || !(await verifyPassword(password, tenant.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    res.json({
      token: signTenantToken(tenant),
      tenant: publicTenant(tenant),
    });
  } catch (err) {
    console.error('[auth] login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/auth/forgot-password { email }
 * ALWAYS the same generic 200, whether or not the email belongs to a
 * tenant — the response must never reveal which accounts exist. When
 * the tenant does exist, a single-use 1-hour reset token is created
 * (invalidating any prior unused ones) and the raw-token link is
 * emailed; only the token's SHA-256 hash is stored. An email-send
 * failure is logged but never changes the response.
 */
router.post('/forgot-password', async (req, res) => {
  const generic = { ok: true, message: GENERIC_FORGOT_MESSAGE };
  try {
    const email = String(req.body?.email || '').trim();
    if (email) {
      const tenant = await getTenantByEmail(email);
      if (tenant) {
        const rawToken = generateToken();
        await createResetToken(tenant.id, hashToken(rawToken), tokenExpiresAt());
        const resetUrl = buildResetUrl(rawToken, process.env.APP_URL);
        try {
          const sent = await sendPasswordResetEmail(tenant.email, resetUrl);
          if (!sent?.ok) {
            console.error('[auth] password reset email failed for tenant', tenant.id, sent?.error || '');
          }
        } catch (mailErr) {
          console.error('[auth] password reset email error for tenant', tenant.id, mailErr);
        }
      }
    }
    res.json(generic);
  } catch (err) {
    console.error('[auth] forgot-password error:', err);
    // Still generic: a 500 here vs a 200 there would leak account
    // existence just as surely as a different message would.
    res.json(generic);
  }
});

/**
 * POST /api/auth/reset-password { token, password }
 * Validates the token (exists, unused, unexpired), enforces the signup
 * password rule (8+ characters), then replaces the tenant's password
 * hash, spends the token, and invalidates any other outstanding
 * tokens for that tenant.
 */
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password, error } = validateResetRequest(req.body);
    if (error) {
      return res.status(400).json({ error });
    }

    const row = await getResetTokenByHash(hashToken(token));
    if (!row) {
      return res.status(400).json({ error: INVALID_LINK_MESSAGE });
    }
    if (row.used_at) {
      return res.status(410).json({ error: INVALID_LINK_MESSAGE });
    }
    if (!isTokenUsable(row)) {
      return res.status(410).json({ error: INVALID_LINK_MESSAGE });
    }

    await updateTenant(row.tenant_id, { password_hash: await hashPassword(password) });
    await markResetTokenUsed(row.id);
    await invalidateUnusedTokens(row.tenant_id, row.id);

    res.json({ ok: true, message: 'Your password has been reset. You can now log in.' });
  } catch (err) {
    console.error('[auth] reset-password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
