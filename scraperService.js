const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

/**
 * scraperService.js (v4 — crawl logic is v3, delivery is new)
 *
 * Scrapes Google Maps for a query and returns enriched leads:
 *   [{ name, phone, website, email }]
 *
 * v4 adds an optional onLead callback (third argument, or
 * { onLead } object): each lead is enriched and handed to the
 * callback the moment it is fully processed, instead of only being
 * returned in one batch at the end. Background scrape jobs use this
 * to save leads incrementally — a long crawl outlives any HTTP
 * request window, so batch-only delivery lost whole runs to proxy
 * timeouts. With no callback, behavior is unchanged: the full
 * enriched array is returned.
 *
 * v1 read the results FEED cards only (no reliable phone, never an
 * email). v2 clicked each feed card to open its detail panel — better
 * extraction, but the click flow was fragile: in production it returned
 * a single junk lead literally named "Results" (the feed's own header,
 * captured as if it were a business) and healed nothing.
 *
 * v3 never clicks feed cards and never trusts feed chrome:
 *   1. Scroll the feed and collect candidate businesses from ANCHOR
 *      HREFS — only "/maps/place/" links count (filterPlaceLinks).
 *   2. Navigate DIRECTLY to each place URL and read the detail page:
 *      name from the page <h1>, phone from the phone:tel: element,
 *      website from the authority link. A lead's name must pass
 *      isValidBusinessName — generic UI strings ("Results", …) can
 *      never become a lead.
 *   3. Enrich each lead that has a website by fetching the site
 *      (homepage, then /contact, then /contact-us) and extracting the
 *      best contact email. Enrichment failures are per-lead and never
 *      kill the scrape. The browser is always closed, including when
 *      the crawl throws.
 */

// ---------------------------------------------------------------------------
// Email extraction / ranking — pure helpers (unit-tested in tests/)
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Domains that mark an address as machine junk, never a business mailbox:
// error trackers, host/builder infra, placeholder domains.
const JUNK_DOMAIN_PARTS = [
  'sentry',           // 1234abcd@o0.ingest.sentry.io error reports
  'wixpress.com',     // Wix infra
  'secureserver.net', // GoDaddy infra
  'godaddy.com',      // GoDaddy error/report addresses
  'example.com',
  'example.org',
  'example.net',
];

// TLDs that mean the "address" is really an asset filename (logo@2x.png).
const IMAGE_TLDS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'css', 'js', 'ico'];

// Mailboxes we actually want for outreach, best first.
const PREFERRED_LOCALS = ['info', 'contact', 'hello', 'office', 'sales'];

// Never usable for outreach — if these are the only addresses a site
// publishes, the lead simply has no email (null), not a noreply.
const NO_OUTREACH_LOCALS = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'webmaster', 'postmaster', 'mailer-daemon', 'abuse',
];

/** Extract every email-shaped string from an HTML blob (deduped, lowercased). */
function extractEmails(html) {
  if (!html) return [];
  // Sites sometimes entity-encode addresses (info&#64;shop.com).
  const decoded = String(html)
    .replace(/&#0?64;|&#x40;/gi, '@')
    .replace(/&#0?46;|&#x2e;/gi, '.');
  const found = decoded.match(EMAIL_RE) || [];
  return [...new Set(found.map((e) => e.toLowerCase()))];
}

/**
 * Score one candidate. -1 = unusable (junk or no-outreach); higher = better.
 * `preferredDomain` (the business's own host) earns a bonus so an on-domain
 * mailbox beats a random Gmail address found in a footer.
 */
function scoreEmail(email, preferredDomain) {
  const at = email.lastIndexOf('@');
  if (at < 1) return -1;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (IMAGE_TLDS.includes(domain.split('.').pop())) return -1;
  if (JUNK_DOMAIN_PARTS.some((j) => domain === j || domain.endsWith('.' + j) || domain.includes(j))) return -1;
  if (local.startsWith('your')) return -1; // your@ / yourname@ placeholders
  if (['email', 'name', 'username', 'user', 'you'].includes(local)) return -1;
  if (NO_OUTREACH_LOCALS.includes(local)) return -1;

  let score = 50; // any other real named mailbox (mike@, service@, …)
  if (PREFERRED_LOCALS.includes(local)) score = 100;
  if (preferredDomain && (domain === preferredDomain || domain.endsWith('.' + preferredDomain))) {
    score += 25;
  }
  return score;
}

/** Pick the best usable email from a candidate list, or null if none qualify. */
function pickBestEmail(candidates, preferredDomain) {
  let best = null;
  let bestScore = 0;
  for (const email of candidates || []) {
    const s = scoreEmail(email, preferredDomain);
    if (s > bestScore) {
      best = email;
      bestScore = s;
    }
  }
  return best;
}

/** Best contact email in an HTML page, or null. */
function extractBestEmail(html, preferredDomain) {
  return pickBestEmail(extractEmails(html), preferredDomain);
}

// ---------------------------------------------------------------------------
// Website email enrichment (plain fetch — no browser needed)
// ---------------------------------------------------------------------------

const FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchHtml(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': FETCH_UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (type && !type.includes('html')) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Find a contact email on a business website: homepage first, then the
 * conventional contact pages — only moving on while no email has been
 * found. Returns the single best email or null. Never throws.
 */
async function findEmailOnSite(website) {
  let base;
  try {
    base = new URL(website);
  } catch {
    return null;
  }
  const host = base.hostname.replace(/^www\./, '');
  const pages = [website, `${base.origin}/contact`, `${base.origin}/contact-us`];

  for (const url of [...new Set(pages)]) {
    const html = await fetchHtml(url);
    if (!html) continue;
    const email = extractBestEmail(html, host);
    if (email) return email;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Place candidates — pure helpers (unit-tested in tests/)
// ---------------------------------------------------------------------------

// Google Maps UI chrome that lives in and around the results feed and can
// look like a "card" to a naive scraper. v2 saved the feed's own header
// as a lead literally named "Results". A business name is never one of
// these strings.
const GENERIC_UI_NAMES = new Set([
  'results',
  'search results',
  'directions',
  'saved',
  'recents',
  'get help',
  'help',
  'sign in',
  'settings',
  'menu',
  'back',
  'back to results',
  'overview',
  'about',
  'reviews',
  'photos',
  'hours',
  'location',
  'share',
  'website',
  'call',
  'send to phone',
  'send to your phone',
  'your places',
  'lists',
  'contribute',
  'updates',
  'notifications',
  'google maps',
  'search google maps',
  'search this area',
  'see all',
  'show more',
  'more results',
]);

/**
 * True when `name` can plausibly be a business: a string that is longer
 * than one character once trimmed and is not Google Maps UI chrome.
 * Every lead name passes through here — from a place page's <h1> or from
 * a result card — so feed chrome can never become a lead.
 */
function isValidBusinessName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length <= 1) return false;
  if (GENERIC_UI_NAMES.has(trimmed.toLowerCase())) return false;
  return true;
}

/** Stable dedupe key for a place URL (the path identifies the place). */
function placeUrlKey(href) {
  return String(href).split('?')[0].replace(/\/+$/, '');
}

/**
 * From a list of anchor hrefs, keep only Google Maps PLACE links (href
 * contains "/maps/place/"), deduped by place, first occurrence wins.
 * Search/dir/home links and non-strings are dropped — feed chrome never
 * becomes a candidate business.
 */
function filterPlaceLinks(hrefs) {
  const seen = new Set();
  const out = [];
  for (const href of hrefs || []) {
    if (typeof href !== 'string') continue;
    if (!href.includes('/maps/place/')) continue;
    const key = placeUrlKey(href);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(href);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Google Maps scraping
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BLOCKED_RE = /unusual traffic|not a robot|verify it'?s you|our systems have detected/i;

/** Runs inside the page: pull name/phone/website out of a place page. */
function extractDetailPanel() {
  const panel = document.querySelector('div[role="main"]') || document;

  const name = (panel.querySelector('h1')?.innerText || '').trim();

  // Phone: the panel's phone button carries data-item-id="phone:tel:<num>".
  let phone = '';
  const phoneEl = panel.querySelector('[data-item-id^="phone:tel:"]');
  if (phoneEl) {
    phone = (phoneEl.getAttribute('data-item-id') || '').replace('phone:tel:', '').trim();
    if (!phone) {
      phone = (phoneEl.getAttribute('aria-label') || '').replace(/^.*?phone:\s*/i, '').trim();
    }
  }
  if (!phone) {
    for (const el of panel.querySelectorAll('button[aria-label], a[aria-label]')) {
      const m = (el.getAttribute('aria-label') || '').match(/^(?:Phone|Call)[:\s]+(.+)$/i);
      if (m) {
        phone = m[1].trim();
        break;
      }
    }
  }

  // Website: the panel's authority link (data-item-id="authority"), with an
  // aria-label fallback. Ignore Google-internal links.
  let website = '';
  const authority = panel.querySelector('a[data-item-id="authority"]');
  if (authority?.href) website = authority.href;
  if (!website) {
    for (const a of panel.querySelectorAll('a[href]')) {
      const label = a.getAttribute('aria-label') || '';
      if (/website/i.test(label) && a.href.startsWith('http') && !a.href.includes('google.')) {
        website = a.href;
        break;
      }
    }
  }

  return { name, phone, website };
}

async function runCrewMindScraper(query, maxResults = 25, options = {}) {
  const onLead = typeof options === 'function'
    ? options
    : (options && typeof options.onLead === 'function' ? options.onLead : null);

  let browser;
  const leads = [];
  const seenLeadNames = new Set();

  /**
   * Enrich one lead, record it, and hand it to onLead immediately.
   * Dedupe by business name happens here so a lead is emitted at
   * most once. Callback failures are logged, never fatal — the lead
   * stays in the returned array so the caller can still see it.
   */
  async function addLead(raw) {
    const lead = {
      name: raw.name,
      phone: raw.phone || '',
      website: raw.website || '',
      email: null,
    };
    const key = lead.name.toLowerCase();
    if (seenLeadNames.has(key)) return;
    seenLeadNames.add(key);

    if (lead.website) {
      try {
        lead.email = await findEmailOnSite(lead.website);
      } catch {
        lead.email = null;
      }
      await sleep(250); // be polite to the sites being enriched
    }

    leads.push(lead);
    if (onLead) {
      try {
        await onLead(lead);
      } catch (err) {
        console.error(`[scraper] onLead callback failed for "${lead.name}": ${err.message}`);
      }
    }
  }

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Best-effort consent interstitial (some IPs/regions get one).
    if (page.url().includes('consent.')) {
      await page
        .evaluate(() => {
          const btn = [...document.querySelectorAll('button')].find((b) =>
            /accept all|i agree|accept/i.test(b.innerText || '')
          );
          if (btn) btn.click();
        })
        .catch(() => {});
      await sleep(1500);
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    const feedSelector = 'div[role="feed"]';
    const hasFeed = await page
      .waitForSelector(feedSelector, { timeout: 20000 })
      .then(() => true)
      .catch(() => false);

    if (!hasFeed) {
      // Blocked (CAPTCHA / unusual-traffic interstitial) or a single-result
      // search that landed straight on a place page. Distinguish them: a
      // place page has a panel with an <h1>; a block page explains itself.
      const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (BLOCKED_RE.test(pageText)) {
        throw new Error('Google Maps blocked the request (CAPTCHA / unusual-traffic interstitial).');
      }
      if (page.url().includes('/maps/place/')) {
        const single = await page.evaluate(extractDetailPanel).catch(() => null);
        if (single && isValidBusinessName(single.name)) {
          await addLead(single);
        }
      }
      return leads;
    }

    // Scroll the feed until the number of unique PLACE links stops growing
    // (or maxResults is reached). Candidates come from anchor hrefs only —
    // only "/maps/place/" links count, so the feed header ("Results") and
    // other chrome never enter the candidate list.
    let placeHrefs = [];
    let lastCount = -1;
    let stableRounds = 0;
    while (stableRounds < 3) {
      const hrefs = await page
        .evaluate(() => {
          const feed = document.querySelector('div[role="feed"]');
          if (feed) feed.scrollTo(0, feed.scrollHeight);
          return [...feed.querySelectorAll('a[href]')].map((a) => a.href);
        })
        .catch(() => []);
      placeHrefs = filterPlaceLinks(hrefs);
      if (placeHrefs.length >= maxResults) break;
      stableRounds = placeHrefs.length === lastCount ? stableRounds + 1 : 0;
      lastCount = placeHrefs.length;
      await sleep(900);
    }
    const targets = placeHrefs.slice(0, maxResults);

    // Fallback names from the result cards themselves (each place anchor's
    // aria-label, or the card's headline element) — never container chrome.
    // Used only when a place page's <h1> won't read; still validator-gated.
    const cardNames = await page
      .evaluate(() => {
        const out = {};
        for (const a of document.querySelectorAll('div[role="feed"] a[href*="/maps/place/"]')) {
          let name = (a.getAttribute('aria-label') || '').trim();
          let node = a;
          for (let up = 0; up < 6 && node && !name; up++) {
            node = node.parentElement;
            const el = node?.querySelector?.('div.fontHeadlineSmall');
            if (el) name = el.innerText.trim();
          }
          if (name && !(a.href in out)) out[a.href] = name;
        }
        return out;
      })
      .catch(() => ({}));
    const cardNameByKey = new Map();
    for (const [href, name] of Object.entries(cardNames)) {
      const key = placeUrlKey(href);
      if (!cardNameByKey.has(key)) cardNameByKey.set(key, name);
    }

    // Visit each place page DIRECTLY. No feed-card clicking: the v2 click
    // flow opened the wrong thing often enough to poison production data.
    for (const placeUrl of targets) {
      try {
        await page.goto(placeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // A bounced navigation lands back on a search/list page — skip it.
        if (!page.url().includes('/maps/place/')) continue;

        await page
          .waitForSelector('div[role="main"] h1, h1.DUwDvf, h1', { timeout: 8000 })
          .catch(() => {});
        await sleep(600); // phone/website buttons hydrate late

        const data = await page.evaluate(extractDetailPanel).catch(() => null);
        let name = (data?.name || '').trim();
        if (!isValidBusinessName(name)) {
          const fallback = (cardNameByKey.get(placeUrlKey(placeUrl)) || '').trim();
          if (isValidBusinessName(fallback)) name = fallback;
        }
        if (!isValidBusinessName(name)) continue; // no trustworthy name → not a lead

        // Enriched + emitted via onLead inside addLead (dedupe included).
        await addLead({
          name,
          phone: data?.phone || '',
          website: data?.website || '',
        });
      } catch {
        // One unreachable or broken place page must not sink the run.
        continue;
      }
      await sleep(400); // be polite to Maps between place pages
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  // Leads were enriched (and emitted via onLead) one by one in addLead
  // as the crawl went — there is no batch enrichment step anymore, so
  // a caller using onLead has already received every lead in `leads`.
  return leads;
}

module.exports = {
  runCrewMindScraper,
  // Exported for unit tests (tests/).
  extractEmails,
  pickBestEmail,
  extractBestEmail,
  findEmailOnSite,
  isValidBusinessName,
  filterPlaceLinks,
};
