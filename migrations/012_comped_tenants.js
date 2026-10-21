/**
 * migrations/012_comped_tenants.js
 *
 * Lifetime comp accounts (operator-granted free forever).
 *   is_comped  — the comp flag. It is an OVERLAY on top of the tenant's
 *                stored status: effectiveStatus() reports 'active' for a
 *                comped tenant no matter what the stored status/trial
 *                clock says, and granting/revoking never rewrites the
 *                stored status, so an uncomp restores exactly the state
 *                the tenant's trial/subscription dictates.
 *   comped_at  — when the comp was granted (audit/display); NULL when
 *                the tenant is not currently comped.
 */

module.exports = {
  name: '012_comped_tenants',

  up: async (client) => {
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_comped BOOLEAN NOT NULL DEFAULT false;`);
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS comped_at TIMESTAMPTZ;`);
  },

  down: async (client) => {
    await client.query(`ALTER TABLE tenants DROP COLUMN IF EXISTS comped_at;`);
    await client.query(`ALTER TABLE tenants DROP COLUMN IF EXISTS is_comped;`);
  }
};
