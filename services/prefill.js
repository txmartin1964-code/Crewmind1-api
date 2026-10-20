/**
 * services/prefill.js
 * Owns: Best-effort business prefill for onboarding — given a business
 * name + city, look up the business's public Google Places listing and
 * return its address, phone, website, and hours so the owner confirms
 * instead of typing.
 * Does NOT own: onboarding flow state (routes/onboarding.js).
 *
 * HARD RULE: prefill never blocks onboarding. No API key, no match, a
 * timeout, or any API error all return { found: false } and the wizard
 * falls back to clean manual entry.
 *
 * Env: GOOGLE_PLACES_API_KEY (falls back to GOOGLE_MAPS_API_KEY /
 * GOOGLE_API_KEY).
 */

const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';
const TIMEOUT_MS = 6000;

function placesKey() {
  return process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY || null;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Places HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getBusinessPrefill(businessName, city) {
  const key = placesKey();
  if (!key || !businessName) return { found: false, reason: 'not_configured' };

  try {
    const query = encodeURIComponent(`${businessName} ${city || ''}`.trim());
    const search = await fetchJson(`${PLACES_BASE}/textsearch/json?query=${query}&key=${key}`);
    const first = (search.results || [])[0];
    if (!first || !first.place_id) return { found: false, reason: 'no_match' };

    const fields = 'name,formatted_address,formatted_phone_number,website,opening_hours';
    const details = await fetchJson(
      `${PLACES_BASE}/details/json?place_id=${encodeURIComponent(first.place_id)}&fields=${fields}&key=${key}`
    );
    const d = details.result || {};
    const hours = d.opening_hours && Array.isArray(d.opening_hours.weekday_text)
      ? d.opening_hours.weekday_text.join('\n')
      : null;

    return {
      found: true,
      source: 'google_places',
      google_place_id: first.place_id,
      business_name: d.name || first.name || businessName,
      address: d.formatted_address || first.formatted_address || null,
      phone: d.formatted_phone_number || null,
      website: d.website || null,
      hours,
    };
  } catch (err) {
    console.error('[prefill] lookup failed (non-blocking):', err.message);
    return { found: false, reason: 'lookup_failed' };
  }
}

module.exports = { getBusinessPrefill };
