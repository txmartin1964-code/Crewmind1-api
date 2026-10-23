/**
 * tests/scrape-jobs.test.js
 *
 * Unit tests for the v4 background scrape-job registry
 * (lib/scrape-jobs.js): start/conflict transitions, incremental-save
 * counters, finish/fail transitions, and the status listing. These
 * exist because v3's synchronous scrape lost whole runs to HTTP
 * timeouts — the job lifecycle is the fix and must not regress.
 * Plain node + assert — the repo has no test framework.
 * Run: node tests/scrape-jobs.test.js
 */

const assert = require('node:assert');
const {
  createJobRegistry, startJob, noteLeadSaved, noteLeadSaveFailed,
  finishJob, failJob, listJobs, snapshotJob,
} = require('../lib/scrape-jobs');

let passed = 0;
function check(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  passed++;
  console.log(`  ok — ${label}`);
}

const t0 = new Date('2026-10-22T23:45:00.000Z');
const t1 = new Date('2026-10-22T23:52:00.000Z');

// --- start / conflict -------------------------------------------------------

const reg = createJobRegistry();
const first = startJob(reg, { kind: 'buyers', query: 'roofing contractors in Fort Worth TX', now: t0 });
check('first start succeeds', first.started, true);
check('job is running', first.job.status, 'running');
check('job carries the spec fields', {
  kind: first.job.kind, query: first.job.query,
  startedAt: first.job.startedAt, finishedAt: first.job.finishedAt, savedCount: first.job.savedCount,
}, {
  kind: 'buyers', query: 'roofing contractors in Fort Worth TX',
  startedAt: '2026-10-22T23:45:00.000Z', finishedAt: null, savedCount: 0,
});
check('job has a lastMessage', typeof first.job.lastMessage, 'string');

const dupe = startJob(reg, { kind: 'buyers', query: 'plumbers in Dallas TX', now: t0 });
check('second start of the same kind conflicts', dupe.started, false);
check('conflict returns the running job', dupe.job.id, first.job.id);

const other = startJob(reg, { kind: 'clients', query: 'roof repair quotes near Fort Worth TX', now: t0 });
check('a different kind may run concurrently', other.started, true);
check('job ids are unique', other.job.id !== first.job.id, true);

// --- incremental save counters ----------------------------------------------

noteLeadSaved(first.job, { saved: 1, duplicates: 0 });       // fresh insert
check('insert advances saved+new', [first.job.savedCount, first.job.newCount, first.job.duplicateCount], [1, 1, 0]);
noteLeadSaved(first.job, { saved: 0, duplicates: 1 });       // heal-on-rescrape
check('heal counts as saved + duplicate', [first.job.savedCount, first.job.newCount, first.job.duplicateCount], [2, 1, 1]);
check('found tracks processed leads', first.job.foundCount, 2);
noteLeadSaveFailed(first.job, new Error('db blip'));
check('a failed save advances only errorCount', [first.job.savedCount, first.job.errorCount], [2, 1]);

// --- finish / fail transitions ----------------------------------------------

finishJob(reg, first.job, undefined, t1);
check('finish marks done + stamps finishedAt', [first.job.status, first.job.finishedAt], ['done', '2026-10-22T23:52:00.000Z']);
check('default finish message summarizes counts', /2 found, 2 saved \(1 new, 1 duplicate\/healed\)/.test(first.job.lastMessage), true);

const again = startJob(reg, { kind: 'buyers', query: 'roofing contractors in Fort Worth TX', now: t1 });
check('same kind can start again after finishing', again.started, true);

failJob(reg, other.job, new Error('Google Maps blocked the request'), t1);
check('fail marks error + stamps finishedAt', [other.job.status, other.job.finishedAt], ['error', '2026-10-22T23:52:00.000Z']);
check('fail message keeps the cause + saved-so-far note', /Google Maps blocked/.test(other.job.lastMessage), true);

// --- status listing ----------------------------------------------------------

const jobs = listJobs(reg);
check('listing has the last job per kind', jobs.length, 2);
check('listing is most-recent first', jobs[0].id > jobs[1].id, true);
check('listing snapshots are plain copies (no Maps/functions)', Object.keys(jobs[0]).sort(), [
  'duplicateCount', 'errorCount', 'finishedAt', 'foundCount', 'id', 'kind',
  'lastMessage', 'newCount', 'query', 'savedCount', 'startedAt', 'status',
]);
check('snapshotJob(null) is null', snapshotJob(null), null);

console.log(`\nAll ${passed} assertions passed.`);
