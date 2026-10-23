/**
 * tests/scraper-email.test.js
 *
 * Unit tests for the scraper's email extraction/ranking helpers
 * (scraperService.js). Plain node + assert — the repo has no test
 * framework. Run: node tests/scraper-email.test.js
 */

const assert = require('node:assert');
const { extractEmails, pickBestEmail, extractBestEmail } = require('../scraperService');

let passed = 0;
function check(label, actual, expected) {
  assert.strictEqual(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  passed++;
  console.log(`  ok — ${label}`);
}

// 1. A realistic contact page: a good info@ buried among junk addresses.
const contactPage = `
  <html><head><title>Contact — Fort Worth Roofing Co</title></head>
  <body>
    <img src="/img/logo@2x.png" srcset="/img/logo@2x.png 2x">
    <a href="mailto:noreply@fortworthroofing.com">Do not reply</a>
    <p>Questions? Email us at <a href="mailto:info@fortworthroofing.com">info@fortworthroofing.com</a></p>
    <script src="https://o123.ingest.sentry.io/static/js/bundle.js" data-sentry="deadbeef@sentry.io"></script>
    <p class="fineprint">Copyright fortworthroofing.com, hosted by someone@godaddy.com</p>
  </body></html>`;
check('contact page yields the info@ mailbox', extractBestEmail(contactPage, 'fortworthroofing.com'), 'info@fortworthroofing.com');

// 2. Junk extraction: image filenames, sentry, godaddy/secureserver, example.*,
//    and your@ placeholders are all dropped by extractEmails-level scoring.
check(
  'image filename is not an email',
  extractBestEmail('<img src="logo@2x.png"><img src="team@2x.jpg">'),
  null
);
check('sentry addresses are junk', extractBestEmail('<p>report to 9f8e@sentry.io</p>'), null);
check(
  'secureserver/godaddy addresses are junk',
  extractBestEmail('<p>bounce@secureserver.net, admin@godaddy.com</p>'),
  null
);
check('example.com/org placeholders are junk', extractBestEmail('<p>you@example.com, test@example.org</p>'), null);
check('your@ placeholders are junk', extractBestEmail('<p>your@email.com, yourname@shop.com</p>'), null);

// 3. Noreply-only page → null (for outreach, no email beats a noreply).
check(
  'only noreply/donotreply/webmaster → null',
  extractBestEmail('<a href="mailto:noreply@shop.com">x</a><a href="mailto:webmaster@shop.com">w</a><p>donotreply@shop.com</p>'),
  null
);

// 4. A named mailbox is a perfectly good email when nothing preferred exists.
check(
  'named mailbox is used when it is all we have',
  extractBestEmail('<p>Reach Mike directly: mike@dallasroofing.com</p>', 'dallasroofing.com'),
  'mike@dallasroofing.com'
);

// 5. Preferred locals beat named mailboxes regardless of order in the page.
check(
  'sales@ beats an earlier named mailbox',
  extractBestEmail('<p>bob@shop.com</p><p>sales@shop.com</p>', 'shop.com'),
  'sales@shop.com'
);

// 6. On-domain beats off-domain at the same tier.
check(
  'on-domain named mailbox beats off-domain one',
  pickBestEmail(['jane@gmail.com', 'jane@shop.com'], 'shop.com'),
  'jane@shop.com'
);

// 7. Entity-encoded addresses are decoded and found.
check(
  'entity-encoded mailto is decoded',
  extractBestEmail('<a href="mailto:hello&#64;shop.com">mail</a>', 'shop.com'),
  'hello@shop.com'
);

// 8. extractEmails dedupes and lowercases.
check(
  'extractEmails dedupes/lowercases',
  JSON.stringify(extractEmails('<p>Info@Shop.com info@shop.com INFO@SHOP.COM</p>')),
  JSON.stringify(['info@shop.com'])
);

// 9. Empty/garbage input is safe.
check('empty html → null', extractBestEmail(''), null);
check('no emails → null', extractBestEmail('<p>Call us at (817) 555-0134</p>'), null);

console.log(`\nAll ${passed} assertions passed.`);
