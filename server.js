/**
 * server.js - CrewMind Backend Entry Point
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { runCrewMindScraper } = require('./scraperService.js');
const { saveScrapedLeads } = require('./db/scraped-leads');

const app = express();
const port = process.env.PORT || 3000;

// Fail fast if DATABASE_URL is missing
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

// -- CORS & PARSING MIDDLEWARE
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// -- STRIPE WEBHOOK (mounted BEFORE the JSON parser, on purpose)
// Stripe signature verification needs the exact raw request body, so this
// one route gets express.raw(). body-parser marks the request as parsed,
// so the global JSON parser below skips this path and all other JSON
// routes are unaffected.
const paymentsRoutes = require('./routes/payments');
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), paymentsRoutes.webhook);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -- HEALTH CHECK
app.get('/health', (req, res) => res.json({ status: 'healthy' }));

// -- STATIC FILES
// extensions:['html'] lets clean URLs like /book and /get-quote resolve to
// book.html / get-quote.html — emailed booking links use the /book form.
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// -- API ROUTES
const adminRoutes = require('./routes/admin');
const { requireAdmin } = adminRoutes;

const contractRoutes = require('./routes/contracts');

app.use('/api/leads', require('./routes/leads'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/payments', paymentsRoutes);
app.use('/api/contracts', contractRoutes.publicRouter);
app.use('/api/admin/contracts', contractRoutes.adminRouter);
app.use('/api/admin', adminRoutes);

// -- LANDING PAGE
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.type('html').send(fs.readFileSync(htmlPath, 'utf8'));
  } else {
    res.json({ message: 'CrewMind - Lead to Booking Engine' });
  }
});

// -- SCRAPER ENDPOINTS
// Both scraper endpoints require the admin token: they burn real server
// resources (headless Chrome) and harvest contact data, so they are not
// public. Fails closed (503) when ADMIN_TOKEN is unset, like the admin API.
app.post('/api/admin/scrape-buyers', requireAdmin, async (req, res) => {
  const { category, city } = req.body;
  try {
    const query = `${category} in ${city}`;
    const buyerleads = await runCrewMindScraper(query, 50);
    const { saved, duplicates } = await saveScrapedLeads(buyerleads, { query, source: 'admin_buyers' });
    console.log(`[scraper] buyers "${query}": ${buyerleads.length} found, ${saved} saved, ${duplicates} duplicate(s) skipped.`);
    res.json({ success: true, count: buyerleads.length, saved, duplicates, leads: buyerleads, buyerleads });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/client/scrape-leads', requireAdmin, async (req, res) => {
  const { targetService, targetArea } = req.body;
  try {
    const query = `${targetService} quotes near ${targetArea}`;
    const clientleads = await runCrewMindScraper(query, 20);
    const { saved, duplicates } = await saveScrapedLeads(clientleads, { query, source: 'client_leads' });
    console.log(`[scraper] clients "${query}": ${clientleads.length} found, ${saved} saved, ${duplicates} duplicate(s) skipped.`);
    res.json({ success: true, count: clientleads.length, saved, duplicates, leads: clientleads, clientleads });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// -- STARTUP: RUN MIGRATIONS THEN LISTEN
async function startServer() {
  try {
    await runMigrations();
  } catch (err) {
    console.error('Migration failed - aborting startup:', err.message);
    process.exit(1);
  }

  // Top up booking availability (next 30 business days). Non-fatal: the
  // server still runs without it, but booking would have nothing to offer,
  // so log loudly. Also runnable on demand: POST /api/admin/slots/generate.
  try {
    const { ensureUpcomingSlots } = require('./db/appointments');
    const result = await ensureUpcomingSlots();
    console.log(`[slots] availability topped up: ${result.inserted} new slot(s), ${result.business_days} business days covered.`);
  } catch (err) {
    console.error('[slots] FAILED to generate availability slots:', err.message);
  }

  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

async function runMigrations() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  });

  const client = await pool.connect();
  try {
    // Migration tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Core users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        password_hash VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        stripe_subscription_id VARCHAR(255),
        subscription_status VARCHAR(50),
        subscription_plan VARCHAR(255),
        subscription_expires_at TIMESTAMPTZ,
        subscription_updated_at TIMESTAMPTZ
      );
    `);
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (LOWER(email));');
    await client.query('CREATE INDEX IF NOT EXISTS users_stripe_subscription_id_idx ON users (stripe_subscription_id);');

    // Folder migrations
    const migrationsDir = path.join(__dirname, 'migrations');
    if (fs.existsSync(migrationsDir)) {
      const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.js')).sort();
      const applied = await client.query('SELECT name FROM _migrations');
      const appliedNames = new Set(applied.rows.map(r => r.name));

      for (const file of files) {
        const migration = require(path.join(migrationsDir, file));
        const name = migration.name || file.replace('.js', '');
        if (appliedNames.has(name)) continue;

        console.log(`Running migration: ${name}`);
        await client.query('BEGIN');
        try {
          await migration.up(client);
          await client.query('INSERT INTO _migrations (name) VALUES ($1)', [name]);
          await client.query('COMMIT');
          console.log(`Migration complete: ${name}`);
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Migration failed (${name}): ${err.message}`);
        }
      }
    }

    console.log('Startup migrations complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

startServer();
