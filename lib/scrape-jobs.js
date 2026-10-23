/**
 * lib/scrape-jobs.js
 * Owns: The in-memory registry for background scrape jobs.
 * Does NOT own: the crawl (scraperService.js), persistence
 * (db/scraped-leads.js), HTTP handling (server.js).
 *
 * Why this exists (v4): a full crawl — visiting each business's Maps
 * place page and then enriching from its website — takes far longer
 * than an HTTP request window. Render's proxy cut the synchronous
 * request off (~502 after ~3 min) and, because the old handler only
 * saved after the entire crawl returned, the whole run was lost.
 * Scrapes now run as background jobs in-process; the request that
 * starts one returns immediately and leads are saved incrementally
 * as each one is processed (see server.js + the scraper's onLead
 * callback).
 *
 * The registry is deliberately in-memory and per-process: a server
 * restart drops job history, which is fine — jobs are short-lived
 * operator actions, and saved leads are already in the database.
 * One job per kind ('buyers' | 'clients') may run at a time.
 */

function createJobRegistry() {
  return {
    nextId: 1,
    runningByKind: new Map(), // kind -> job (status 'running')
    lastByKind: new Map(),    // kind -> most recent job (any status)
  };
}

/** Public, JSON-safe view of a job. */
function snapshotJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    kind: job.kind,
    query: job.query,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    foundCount: job.foundCount,
    savedCount: job.savedCount,
    newCount: job.newCount,
    duplicateCount: job.duplicateCount,
    errorCount: job.errorCount,
    lastMessage: job.lastMessage,
  };
}

/**
 * Try to start a job of `kind`. If one of that kind is already
 * running, returns { started: false, job: <the running job> } so the
 * caller can answer 409. Otherwise creates the job, marks it running,
 * and returns { started: true, job }.
 */
function startJob(registry, { kind, query, now = new Date() } = {}) {
  const running = registry.runningByKind.get(kind);
  if (running && running.status === 'running') {
    return { started: false, job: running };
  }
  const job = {
    id: registry.nextId++,
    kind,
    query,
    status: 'running',
    startedAt: now.toISOString(),
    finishedAt: null,
    foundCount: 0,
    savedCount: 0,
    newCount: 0,
    duplicateCount: 0,
    errorCount: 0,
    lastMessage: 'Scrape running in the background — results land in the pipeline as they are found.',
  };
  registry.runningByKind.set(kind, job);
  registry.lastByKind.set(kind, job);
  return { started: true, job };
}

/**
 * Record one lead persisted through the job's incremental-save
 * callback. `result` is db/scraped-leads' { saved, duplicates } for
 * that single lead: an insert counts as new, a heal-on-rescrape counts
 * as a duplicate — both mean the lead is now in the pipeline, so both
 * advance savedCount.
 */
function noteLeadSaved(job, result = {}) {
  const saved = result.saved || 0;
  const duplicates = result.duplicates || 0;
  job.foundCount += 1;
  job.savedCount += saved + duplicates;
  job.newCount += saved;
  job.duplicateCount += duplicates;
  job.lastMessage = `Running — ${job.savedCount} prospect(s) saved so far.`;
  return job;
}

/** Record a lead whose incremental save failed (retried at job end). */
function noteLeadSaveFailed(job, err) {
  job.errorCount += 1;
  job.lastMessage = `Running — a save failed (${(err && err.message) || 'unknown error'}); it will be retried when the crawl finishes.`;
  return job;
}

function finishJob(registry, job, message, now = new Date()) {
  job.status = 'done';
  job.finishedAt = now.toISOString();
  job.lastMessage = message ||
    `Done — ${job.foundCount} found, ${job.savedCount} saved (${job.newCount} new, ${job.duplicateCount} duplicate/healed).`;
  if (registry.runningByKind.get(job.kind) === job) {
    registry.runningByKind.delete(job.kind);
  }
  return job;
}

function failJob(registry, job, err, now = new Date()) {
  job.status = 'error';
  job.finishedAt = now.toISOString();
  job.lastMessage = `Scrape failed: ${(err && err.message) || 'unknown error'} — ${job.savedCount} prospect(s) had already been saved and are in the pipeline.`;
  if (registry.runningByKind.get(job.kind) === job) {
    registry.runningByKind.delete(job.kind);
  }
  return job;
}

/** Current/last job per kind, most recently started first. */
function listJobs(registry) {
  return [...registry.lastByKind.values()]
    .sort((a, b) => b.id - a.id)
    .map(snapshotJob);
}

module.exports = {
  createJobRegistry,
  startJob,
  noteLeadSaved,
  noteLeadSaveFailed,
  finishJob,
  failJob,
  listJobs,
  snapshotJob,
};
