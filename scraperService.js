const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

async function runCrewMindScraper(query, maxResults = 25) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;

  await page.goto(searchUrl, { waitUntil: 'networkidle2' });

  const leads = await page.evaluate((limit) => {
    const items = Array.from(document.querySelectorAll('div[role="feed"] > div'));
    const results = [];

    for (let el of items) {
      if (results.length >= limit) break;

      const name = el.querySelector('div.fontHeadlineSmall')?.innerText;
      const phone = el.querySelector('span.UsC13e')?.innerText || '';
      const website = el.querySelector('a[aria-label*="website"]')?.href || '';

      if (name) {
        results.push({ name, phone, website });
      }
    }
    return results;
  }, maxResults);

  await browser.close();
  return leads;
}

module.exports = { runCrewMindScraper };
