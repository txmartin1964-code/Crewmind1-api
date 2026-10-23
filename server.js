/**
 * server.js - CrewMind Backend Entry Point
 */

// Puppeteer cache: Render does not carry the default ~/.cache/puppeteer from
// build into the runtime filesystem, so Chrome must live in the deployed
// project directory (package.json's postinstall installs it there). This must
// be set before any require pulls in puppeteer. An externally set
// PUPPETEER_CACHE_DIR still wins.
process.env.PUPPETEER_CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || require('path').join(__dirname, '.cache', 'puppeteer');

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { runCrewMindScraper } = require('./scraperService.js');
const { saveScrapedLead, saveScrapedLeads } = require('./db/scraped-leads');
const {
  createJobRegistry, startJob, noteLeadSaved, noteLeadSaveFailed,
  finishJob, failJob, listJobs, snapshotJob,
} = require('./lib/scrape-jobs');

// Brand icons ship as base64 text (public/assets-b64/) and are decoded into
// public/assets/ at boot — see lib/restore-assets.js.
require('./lib/restore-assets').ensureBrandAssets(__dirname);

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

app.use('/api/auth', require('./routes/auth'));
app.use('/api/signup', require('./routes/signup'));
app.use('/api/onboarding', require('./routes/onboarding'));
app.get('/q/:slug', require('./routes/quote-page').quotePageHandler);
// Billing is mounted BEFORE the general tenant router: a locked tenant
// must still be able to reach checkout to un-lock themselves.
app.use('/api/tenant/billing', require('./routes/billing'));
app.use('/api/tenant', require('./routes/tenant'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/payments', paymentsRoutes);
app.use('/api/contracts', contractRoutes.publicRouter);
app.use('/api/change-orders', require('./routes/change-orders'));
app.use('/api/reviews', require('./routes/reviews'));
// Phone webhooks (Phase 10): called by Twilio, NOT admin-token gated —
// they gate themselves (503 until Twilio env is set, then Twilio
// signature validation). See routes/phone.js.
app.use('/api/phone', require('./routes/phone'));
app.use('/api/admin/contracts', contractRoutes.adminRouter);
const gtmRoutes = require('./routes/gtm');
app.use('/api/admin', gtmRoutes.adminRouter);
app.use('/api/gtm', gtmRoutes.publicRouter);
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

// -- SCRAPER ENDPOINTS (v4: background jobs + incremental save)
// Both scraper endpoints require the admin token: they burn real server
// resources (headless Chrome) and harvest contact data, so they are not
// public. Fails closed (503) when ADMIN_TOKEN is unset, like the admin API.
//
// Why jobs: the v3 crawl (visit each place page + website enrichment)
// runs far longer than an HTTP request window — Render's proxy cut the
// synchronous request off (~502) and, because saving happened only
// after the whole crawl returned, the entire run was lost. Now the
// POST only STARTS a job and returns immediately; the crawl runs
// in-process and each lead is saved the moment it is processed via
// the scraper's onLead callback. Progress is at GET scrape-status.
const scrapeJobRegistry = createJobRegistry();
const BUYER_SCRAPE_MAX = 25; // per run — repeatable runs, heal-on-rescrape fills gaps
const CLIENT_SCRAPE_MAX = 20;

/**
 * Start a background scrape job. Returns false (+ the running job)
 * when a job of this kind is already running. The crawl promise is
 * deliberately NOT tied to any request: it runs to completion (or
 * failure) in-process, updating the job record as leads land.
 */
function launchScrapeJob(kind, query, source, maxResults) {
  const { started, job } = startJob(scrapeJobRegistry, { kind, query });
  if (!started) return { started: false, job };

  (async () => {
    // Leads whose incremental save failed get ONE bulk retry at the
    // end — they were never counted as saved, so this cannot
    // double-save leads the callback already persisted.
    const failedLeads = [];
    try {
      const leads = await runCrewMindScraper(query, maxResults, {
        onLead: async (lead) => {
          try {
            const result = await saveScrapedLead(lead, { query, source, tenantId: 1 });
            noteLeadSaved(job, result);
          } catch (err) {
            console.error(`[scraper] incremental save failed for "${lead.name}": ${err.message}`);
            noteLeadSaveFailed(job, err);
            failedLeads.push(lead);
          }
        },
      });

      if (failedLeads.length) {
        try {
          const retry = await saveScrapedLeads(failedLeads, { query, source, tenantId: 1 });
          job.foundCount += failedLeads.length;
          job.savedCount += (retry.saved || 0) + (retry.duplicates || 0);
          job.newCount += retry.saved || 0;
          job.duplicateCount += retry.duplicates || 0;
        } catch (err) {
          console.error(`[scraper] end-of-run save retry failed for "${query}": ${err.message}`);
        }
      }

      finishJob(scrapeJobRegistry, job,
        `Done — ${leads.length} result(s) found, ${job.savedCount} saved to the pipeline ` +
        `(${job.newCount} new, ${job.duplicateCount} duplicate/healed). Cap is ${maxResults} per run — run again for more.`);
      console.log(`[scraper] ${kind} job ${job.id} "${query}": ${leads.length} found, ${job.savedCount} saved (${job.newCount} new, ${job.duplicateCount} dup/healed).`);
    } catch (err) {
      failJob(scrapeJobRegistry, job, err);
      console.error(`[scraper] ${kind} job ${job.id} "${query}" failed: ${err.message} (${job.savedCount} lead(s) saved before the failure are in the pipeline).`);
    }
  })().catch((err) => console.error(`[scraper] job runner crashed: ${err.message}`));

  return { started: true, job };
}

function startScrapeResponse(res, kind, query, source, maxResults) {
  const { started, job } = launchScrapeJob(kind, query, source, maxResults);
  if (!started) {
    return res.status(409).json({
      success: false,
      started: false,
      error: `A ${kind} scrape is already running (job ${job.id}, started ${job.startedAt}). Wait for it to finish — progress is on the scrape-status endpoint.`,
      job: snapshotJob(job),
    });
  }
  return res.json({
    success: true,
    started: true,
    jobId: job.id,
    job: snapshotJob(job),
    message: `Scrape running in the background (cap ${maxResults} per run) — results land in the pipeline as they're found; refresh in a few minutes.`,
  });
}

app.post('/api/admin/scrape-buyers', requireAdmin, (req, res) => {
  const { category, city } = req.body || {};
  if (!category || !city) {
    return res.status(400).json({ success: false, error: 'category and city are required.' });
  }
  const query = `${category} in ${city}`;
  return startScrapeResponse(res, 'buyers', query, 'admin_buyers', BUYER_SCRAPE_MAX);
});

function handleClientScrape(req, res) {
  const { targetService, targetArea } = req.body || {};
  if (!targetService || !targetArea) {
    return res.status(400).json({ success: false, error: 'targetService and targetArea are required.' });
  }
  const query = `${targetService} quotes near ${targetArea}`;
  return startScrapeResponse(res, 'clients', query, 'client_leads', CLIENT_SCRAPE_MAX);
}

// Canonical v4 path + the pre-v4 path the console used (kept as an alias).
app.post('/api/admin/scrape-clients', requireAdmin, handleClientScrape);
app.post('/api/client/scrape-leads', requireAdmin, handleClientScrape);

app.get('/api/admin/scrape-status', requireAdmin, (req, res) => {
  const jobs = listJobs(scrapeJobRegistry);
  res.json({ success: true, jobs, running: jobs.filter((j) => j.status === 'running') });
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
    const result = await ensureUpcomingSlots({ tenantId: 1 });
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
