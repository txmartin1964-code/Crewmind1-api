/**
 * migrations/006_tenancy.js
 *
 * Phase 2 multi-tenancy.
 * - Creates the tenants table. Tenant 1 is the platform operator (Keith):
 *   the business that ran on Phase 1 becomes the operator's own tenant and
 *   ALL pre-existing rows are backfilled to tenant_id = 1.
 * - Adds tenant_id to every tenant-owned table: leads, quotes,
 *   appointments, available_slots (each tenant has its own calendar),
 *   contracts, scraped_leads, pricing_rules.
 * - pricing_rules uniqueness moves from (job_type) to (tenant_id, job_type)
 *   so every tenant carries its own editable copy of the price book.
 * - app_settings becomes per-tenant: primary key (tenant_id, key).
 * - scraped_leads dedupe index gains tenant_id so tenants never collide.
 */

module.exports = {
  name: '006_tenancy',

  up: async (client) => {
    // 1. Tenants table.
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id SERIAL PRIMARY KEY,
        slug VARCHAR(80) UNIQUE NOT NULL,
        business_name VARCHAR(255),
        owner_name VARCHAR(255),
        email VARCHAR(255),
        password_hash VARCHAR(255),
        status VARCHAR(30) NOT NULL DEFAULT 'trial',
        plan VARCHAR(30) NOT NULL DEFAULT 'core',
        billing_interval VARCHAR(20),
        is_operator BOOLEAN NOT NULL DEFAULT FALSE,
        founding_cohort BOOLEAN NOT NULL DEFAULT FALSE,
        cohort_number INTEGER,
        signup_campaign VARCHAR(100),
        trial_started_at TIMESTAMPTZ,
        trial_ends_at TIMESTAMPTZ,
        stripe_customer_id VARCHAR(255),
        stripe_subscription_id VARCHAR(255),
        subscription_status VARCHAR(50),
        current_period_end TIMESTAMPTZ,
        onboarding_completed_at TIMESTAMPTZ,
        payout_connected BOOLEAN NOT NULL DEFAULT FALSE,
        payout_skipped BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS tenants_email_unique_idx ON tenants (LOWER(email)) WHERE email IS NOT NULL;');
    await client.query('CREATE INDEX IF NOT EXISTS tenants_stripe_customer_idx ON tenants (stripe_customer_id);');
    await client.query('CREATE INDEX IF NOT EXISTS tenants_stripe_subscription_idx ON tenants (stripe_subscription_id);');

    // 2. The operator tenant (id 1) — owner of all Phase 1 data.
    await client.query(`
      INSERT INTO tenants (id, slug, business_name, status, plan, is_operator)
      VALUES (1, 'crewmind', 'CrewMind', 'active', 'core', TRUE)
      ON CONFLICT (id) DO NOTHING;
    `);
    await client.query(`SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), 1));`);

    // 3. tenant_id on every tenant-owned table (backfill = tenant 1).
    for (const table of ['leads', 'quotes', 'appointments', 'available_slots', 'contracts', 'scraped_leads', 'pricing_rules']) {
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1;`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${table}_tenant_idx ON ${table} (tenant_id);`);
    }

    // 4. pricing_rules: unique per (tenant, job_type) instead of global.
    await client.query(`
      DO $$
      DECLARE c TEXT;
      BEGIN
        SELECT conname INTO c FROM pg_constraint
        WHERE conrelid = 'pricing_rules'::regclass AND contype = 'u'
          AND pg_get_constraintdef(oid) LIKE '%(job_type)%'
        LIMIT 1;
        IF c IS NOT NULL THEN
          EXECUTE 'ALTER TABLE pricing_rules DROP CONSTRAINT ' || quote_ident(c);
        END IF;
      END $$;
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pricing_rules_tenant_job_unique') THEN
          ALTER TABLE pricing_rules ADD CONSTRAINT pricing_rules_tenant_job_unique UNIQUE (tenant_id, job_type);
        END IF;
      END $$;
    `);

    // 5. app_settings: per-tenant key/value.
    await client.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS tenant_id INTEGER NOT NULL DEFAULT 1;`);
    await client.query(`
      DO $$
      DECLARE c TEXT;
      BEGIN
        SELECT conname INTO c FROM pg_constraint
        WHERE conrelid = 'app_settings'::regclass AND contype = 'p';
        IF c IS NOT NULL THEN
          EXECUTE 'ALTER TABLE app_settings DROP CONSTRAINT ' || quote_ident(c);
        END IF;
      END $$;
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_settings_tenant_key_pk') THEN
          ALTER TABLE app_settings ADD CONSTRAINT app_settings_tenant_key_pk PRIMARY KEY (tenant_id, key);
        END IF;
      END $$;
    `);

    // 6. scraped_leads gains an email column (the Maps scraper rarely
    //    finds one, but imports/enrichment can — the GTM campaign engine
    //    in migration 010 targets prospects that have one).
    await client.query(`ALTER TABLE scraped_leads ADD COLUMN IF NOT EXISTS email VARCHAR(255);`);

    // 7. scraped_leads dedupe becomes per-tenant.
    await client.query(`DROP INDEX IF EXISTS scraped_leads_dedupe_idx;`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS scraped_leads_dedupe_idx
        ON scraped_leads (tenant_id, name, phone, query);
    `);
  },

  down: async (client) => {
    // Best effort only — tenancy removal is not a supported production path.
    await client.query(`DROP INDEX IF EXISTS scraped_leads_dedupe_idx;`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS scraped_leads_dedupe_idx ON scraped_leads (name, phone, query);`);
    for (const table of ['leads', 'quotes', 'appointments', 'available_slots', 'contracts', 'scraped_leads', 'pricing_rules']) {
      await client.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS tenant_id;`);
    }
    await client.query(`ALTER TABLE app_settings DROP COLUMN IF EXISTS tenant_id;`);
    await client.query(`DROP TABLE IF EXISTS tenants;`);
  }
};
