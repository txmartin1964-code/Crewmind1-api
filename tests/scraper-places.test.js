/**
 * tests/scraper-places.test.js
 *
 * Unit tests for the scraper v3 place-candidate helpers
 * (scraperService.js): filterPlaceLinks and isValidBusinessName.
 * These exist because v2 captured the Maps feed's own "Results" header
 * as a business. Plain node + assert — the repo has no test framework.
 * Run: node tests/scraper-places.test.js
 */

const assert = require('node:assert');
const { filterPlaceLinks, isValidBusinessName } = require('../scraperService');

let passed = 0;
function check(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  passed++;
  console.log(`  ok — ${label}`);
}

const PLACE_A = 'https://www.google.com/maps/place/Lon+Smith+Roofing+%26+Construction/@32.7513,-97.3350,17z/data=!3m1!4b1';
const PLACE_B = 'https://www.google.com/maps/place/Bold+Roofing/@32.7513,-97.3350,17z/data=!3m1!4b1';
const PLACE_C = 'https://www.google.com/maps/place/Priority+Roofing/@32.7513,-97.3350,17z/data=!3m1!4b1';

// --- filterPlaceLinks -------------------------------------------------------

// A realistic href haul from a Maps search page: search/dir/home/chrome
// links mixed with place links, duplicates of the same place included.
check(
  'only place links survive, in first-seen order',
  filterPlaceLinks([
    'https://www.google.com/maps/search/roofing+contractors+fort+worth',
    PLACE_A,
    'https://www.google.com/maps/dir//Fort+Worth,+TX',
    PLACE_B,
    'https://www.google.com/',
    'https://www.google.com/maps',
    PLACE_C,
  ]),
  [PLACE_A, PLACE_B, PLACE_C]
);

check(
  'exact duplicates and query-variant duplicates are deduped',
  filterPlaceLinks([PLACE_A, PLACE_A, `${PLACE_A}?entry=ttu`, PLACE_B, PLACE_B]),
  [PLACE_A, PLACE_B]
);

check(
  'a list with no place links yields nothing',
  filterPlaceLinks([
    'https://www.google.com/maps/search/roofing',
    'https://www.google.com/maps/dir//Dallas,+TX',
    'https://www.google.com/preferences',
    'javascript:void(0)',
    '',
  ]),
  []
);

check(
  'non-strings and empty input are safe',
  filterPlaceLinks([null, undefined, 42, {}, PLACE_A]),
  [PLACE_A]
);
check('undefined input → empty list', filterPlaceLinks(undefined), []);
check('empty input → empty list', filterPlaceLinks([]), []);

// --- isValidBusinessName ----------------------------------------------------

// The v2 bug, verbatim: the feed header became a lead.
check('"Results" is not a business', isValidBusinessName('Results'), false);
check('"results" (lowercase) is not a business', isValidBusinessName('results'), false);
check('" RESULTS " (padded) is not a business', isValidBusinessName(' RESULTS '), false);
check('"Search results" is not a business', isValidBusinessName('Search results'), false);
check('"Directions" is not a business', isValidBusinessName('Directions'), false);
check('"Saved" is not a business', isValidBusinessName('Saved'), false);
check('"Recents" is not a business', isValidBusinessName('Recents'), false);
check('"Get help" is not a business', isValidBusinessName('Get help'), false);

check('empty string is not a business', isValidBusinessName(''), false);
check('whitespace is not a business', isValidBusinessName('   '), false);
check('single character is not a business', isValidBusinessName('A'), false);
check('padded single character is not a business', isValidBusinessName(' x '), false);
check('null is not a business', isValidBusinessName(null), false);
check('undefined is not a business', isValidBusinessName(undefined), false);
check('a number is not a business', isValidBusinessName(42), false);

check(
  'a real roofer passes',
  isValidBusinessName('Lon Smith Roofing & Construction'),
  true
);
check('a short real name passes', isValidBusinessName('DFW Roofing Pro'), true);
check('a two-character name passes', isValidBusinessName('A-1 Roofing'), true);
check(
  'a name containing a chrome word still passes',
  isValidBusinessName('Saved By Grace Roofing Co'),
  true
);

console.log(`\nAll ${passed} assertions passed.`);
