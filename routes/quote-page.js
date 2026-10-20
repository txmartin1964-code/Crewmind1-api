/**
 * routes/quote-page.js
 * Owns: GET /q/:slug — a tenant's public quote page. Serves the shared
 * quote form branded with the tenant's business name; the form posts to
 * /api/leads with the tenant slug, so every lead lands on the right
 * tenant. Unknown slug -> 404; locked tenant -> a polite closed notice
 * (their intake API also refuses with 402).
 */

const fs = require('fs');
const path = require('path');
const { getTenantBySlug, isLocked } = require('../db/tenants');

const FORM_PATH = path.join(__dirname, '..', 'public', 'quote-form.html');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function quotePageHandler(req, res) {
  try {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) {
      return res.status(404).type('html').send('<h1>Business not found</h1><p>This quote page does not exist.</p>');
    }
    if (isLocked(tenant)) {
      return res.type('html').send(
        `<h1>${escapeHtml(tenant.business_name)}</h1>` +
        '<p>Online quote requests are temporarily paused. Please call the business directly.</p>'
      );
    }
    const html = fs.readFileSync(FORM_PATH, 'utf8')
      .split('{{BUSINESS_NAME}}').join(escapeHtml(tenant.business_name));
    return res.type('html').send(html);
  } catch (err) {
    console.error('[quote-page] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

module.exports = { quotePageHandler };
