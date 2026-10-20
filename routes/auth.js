/**
 * routes/auth.js
 * Owns: Tenant authentication endpoints (login). Signup lives in
 * routes/signup.js; this file only turns valid credentials into a
 * session token.
 * Does NOT own: password hashing / token mechanics (lib/auth.js), tenant
 * CRUD (db/tenants.js).
 */

const express = require('express');
const router = express.Router();

const { getTenantByEmail, publicTenant } = require('../db/tenants');
const { verifyPassword, signTenantToken } = require('../lib/auth');

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

module.exports = router;
