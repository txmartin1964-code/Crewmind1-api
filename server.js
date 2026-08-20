/**
 * server.js — Entry point. Wiring only: middleware, route mounts, app.listen.
 * Hard limit: 300 lines. All routes live in routes/, all queries in db/.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// Fail fast if DATABASE_URL is missing
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
// Note: Does NOT query database to allow Neon auto-suspend
app.get('/health', (req, res) => res.json({ status: 'healthy' }));

// ─── STATIC FILES ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.use('/api/leads', require('./routes/leads'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/admin', require('./routes/admin'));

// ─── LANDING PAGE (with analytics beacon) ─────────────────────────────────────
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    const slug = process.env.POLSIA_ANALYTICS_SLUG || '';
    html = html.replace('__POLSIA_SLUG__', slug);
    res.type('html').send(html);
  } else {
    res.json({ message: 'CrewMind — Lead to Booking Engine' });
  }
});

// ─── STARTUP: RUN MIGRATIONS THEN LISTEN ──────────────────────────────────────
async function startServer() {
  try {
    await runMigrations();
  } catch (err) {
    console.error('Migration failed — aborting startup:', err.message);
    process.exit(1);
  } import { runCrewMindScraper } from './scraperService.js';

app.post('/api/admin/scrape-buyers', async (req, res) => {
  const { category, city } = req.body;
  try {
    const query = `${category} in ${city}`;
    const buyerLeads = await runCrewMindScraper(query, 50);
    res.json({ success: true, count: buyerLeads.length, leads: buyerLeads });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/client/scrape-leads', async (req, res) => {
  const { targetService, targetArea } = req.body;
  try {
    const query = `${targetService} quotes near ${targetArea}`;
    const clientLeads = await runCrewMindScraper(query, 20);
    res.json({ success: true, leads: clientLeads });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

async function runMigrations() {
  // Import the migration runner but drive it ourselves so we can await it
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
      )
    `);

    // Core users table (Polsia platform requirement)
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
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (LOWER(email))`);
    await client.query(`CREATE INDEX IF NOT EXISTS users_stripe_subscription_id_idx ON users (stripe_subscription_id)`);

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
