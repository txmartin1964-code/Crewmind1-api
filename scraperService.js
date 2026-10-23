const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

/**
 * scraperService.js (v2)
 *
 * Scrapes Google Maps for a query and returns enriched leads:
 *   [{ name, phone, website, email }]
 *
 * v1 read the results FEED cards only. Feed items don't reliably carry a
 * phone (the old span.UsC13e selector kept missing) and never carry an
 * email, so production prospects landed with a name and nothing else —
 * and the GTM campaign sender only targets prospects WITH emails.
 *
 * v2 opens each result's DETAIL PANEL (where Maps actually puts the
 * phone button and website link), then enriches each lead that has a
 * website by fetching the site (homepage, then /contact, then
 * /contact-us) and extracting the best contact email. Enrichment
 * failures are per-lead and never kill the scrape. The browser is
 * always closed, including when the crawl throws.
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
// Google Maps scraping
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs inside the page: pull name/phone/website out of the open detail panel. */
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

async function runCrewMindScraper(query, maxResults = 25) {
  let browser;
  const leads = [];

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
      if (/unusual traffic|not a robot|verify it'?s you|our systems have detected/i.test(pageText)) {
        throw new Error('Google Maps blocked the request (CAPTCHA / unusual-traffic interstitial).');
      }
      const single = await page.evaluate(extractDetailPanel).catch(() => null);
      if (single?.name) {
        leads.push({ name: single.name, phone: single.phone || '', website: single.website || '', email: null });
      }
      return finishWithEnrichment(leads);
    }

    // Scroll the feed until at least maxResults businesses are loaded
    // (or the feed stops growing).
    await page.evaluate(async (limit) => {
      const feed = document.querySelector('div[role="feed"]');
      if (!feed) return;
      const loaded = () =>
        new Set([...feed.querySelectorAll('a[href*="/maps/place/"]')].map((a) => a.href)).size;
      let last = 0;
      let stableRounds = 0;
      while (loaded() < limit && stableRounds < 4) {
        feed.scrollTo(0, feed.scrollHeight);
        await new Promise((r) => setTimeout(r, 900));
        const now = loaded();
        stableRounds = now === last ? stableRounds + 1 : 0;
        last = now;
      }
    }, maxResults);

    // Snapshot the result cards (name + place link) in feed order.
    const cards = await page.evaluate(() => {
      const links = [...document.querySelectorAll('div[role="feed"] a[href*="/maps/place/"]')];
      const byHref = new Map();
      for (const a of links) {
        if (byHref.has(a.href)) continue;
        let name = '';
        let node = a;
        for (let up = 0; up < 6 && node && !name; up++) {
          node = node.parentElement;
          const el = node?.querySelector?.('div.fontHeadlineSmall');
          if (el) name = el.innerText.trim();
        }
        byHref.set(a.href, { name, href: a.href });
      }
      return [...byHref.values()];
    });

    const targets = cards.slice(0, maxResults);

    for (let i = 0; i < targets.length; i++) {
      const fallbackName = targets[i].name || '';
      try {
        const clicked = await page.evaluate((idx) => {
          const links = [...document.querySelectorAll('div[role="feed"] a[href*="/maps/place/"]')];
          const uniq = [...new Map(links.map((a) => [a.href, a])).values()];
          if (!uniq[idx]) return false;
          uniq[idx].click();
          return true;
        }, i);
        if (!clicked) continue;

        await page
          .waitForSelector('div[role="main"] h1, h1.DUwDvf', { timeout: 6000 })
          .catch(() => {});
        await sleep(700); // panel action buttons (phone/website) hydrate late

        const data = await page.evaluate(extractDetailPanel).catch(() => null);
        const name = data?.name || fallbackName;
        if (name) {
          leads.push({
            name,
            phone: data?.phone || '',
            website: data?.website || '',
            email: null,
          });
        }
      } catch {
        // One bad panel must not sink the run — keep the business by name.
        if (fallbackName) leads.push({ name: fallbackName, phone: '', website: '', email: null });
      }

      // Back to the results feed for the next card.
      if (i < targets.length - 1) {
        const wentBack = await page
          .evaluate(() => {
            const back = document.querySelector(
              'button[aria-label="Back"], button[aria-label*="Back to results"]'
            );
            if (back) {
              back.click();
              return true;
            }
            return false;
          })
          .catch(() => false);
        if (!wentBack) await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForSelector(feedSelector, { timeout: 8000 }).catch(() => {});
        await sleep(500);
      }
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  return finishWithEnrichment(leads);
}

/** Dedupe by business, then attach website emails (per-lead, never fatal). */
async function finishWithEnrichment(leads) {
  const seen = new Set();
  const unique = [];
  for (const lead of leads) {
    const key = lead.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(lead);
  }

  for (const lead of unique) {
    if (!lead.website) continue;
    try {
      lead.email = await findEmailOnSite(lead.website);
    } catch {
      lead.email = null;
    }
    await sleep(250); // be polite to the sites being enriched
  }
  return unique;
}

module.exports = {
  runCrewMindScraper,
  // Exported for unit tests (tests/scraper-email.test.js).
  extractEmails,
  pickBestEmail,
  extractBestEmail,
  findEmailOnSite,
};
