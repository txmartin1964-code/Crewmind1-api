/**
 * lib/pricing-defaults.js
 * Owns: The default pricing rules every business starts with (the 13 job
 * types from the intake form). Used by migration 002 (operator tenant) and
 * by onboarding, which copies these rows into a new tenant's own
 * pricing_rules so each tenant can tune prices independently.
 */

const PRICING_DEFAULTS = [
  // job_type, display_name, base_price_cents, price_per_sqft_cents, notes
  ['roof_repair',        'Roof Repair',        45000,  150,  'Starting ballpark for leak/patch repairs. Final price after roof inspection.'],
  ['roof_replacement',   'Roof Replacement',   150000, 450,  'Ballpark for tear-off and re-shingle. Final price after roof inspection.'],
  ['gutter_cleaning',    'Gutter Cleaning',    17500,  0,    'Flat service price for a standard single-story home.'],
  ['siding_repair',      'Siding Repair',      40000,  200,  'Ballpark for localized siding repair. Final price on site.'],
  ['window_install',     'Window Installation', 65000, 0,    'Priced per window opening, standard size. Final price on site.'],
  ['deck_build',         'Deck Build',         80000,  3500, 'Ballpark per sq ft of deck area, standard lumber. Final price on site.'],
  ['hvac_service',       'HVAC Service',       25000,  15,   'Service call and diagnostic ballpark. Repairs quoted on site.'],
  ['painting_exterior',  'Exterior Painting',  80000,  225,  'Ballpark for full exterior repaint. Final price on site.'],
  ['plumbing_repair',    'Plumbing Repair',    22500,  0,    'Service call ballpark. Repair scope quoted on site.'],
  ['electrical',         'Electrical',         25000,  0,    'Service call ballpark. Scope quoted on site.'],
  ['landscaping',        'Landscaping',        35000,  20,   'Ballpark for cleanup and basic landscaping. Final price on site.'],
  ['flooring_install',   'Flooring Installation', 60000, 550, 'Ballpark per sq ft for standard flooring install. Final price on site.'],
  ['other',              'General Service',    25000,  50,   'General service ballpark. Final price confirmed on site.'],
];

module.exports = { PRICING_DEFAULTS };
