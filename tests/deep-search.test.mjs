import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  countySlug,
  dateVariants,
  dateWindow,
  mergeFacts,
  normalizeFacts,
  scoreCorroboration,
  splitName,
  stateCode,
  stateName,
} from '../lib/deep-search/facts.ts';
import {
  factsFromText,
  factsFromUrl,
  findCounties,
  findDates,
  findMiddleNames,
} from '../lib/deep-search/extract.ts';

// Every fixture below is a real URL or title from the Gene Beachak lead, so
// these tests pin the extraction against the exact chain we are automating.
const GENE = splitName('Gene Beachak');

test('splitName pulls first/last, and the middle when present', () => {
  assert.deepEqual(splitName('Gene Beachak'), { first: 'Gene', last: 'Beachak', middle: '' });
  assert.deepEqual(splitName('Gene Micheal Beachak'), {
    first: 'Gene',
    last: 'Beachak',
    middle: 'Micheal',
  });
  assert.deepEqual(splitName(''), { first: '', last: '', middle: '' });
});

test('recentlybooked record URL yields the state and county from its path', () => {
  const facts = factsFromUrl(
    'https://recentlybooked.com/nc/wake/gene-beachak~206_977665',
    GENE
  );
  assert.deepEqual(facts.state, ['NC']);
  assert.deepEqual(facts.county, ['Wake']);
  assert.ok(facts.record_ids.includes('206_977665'));
});

test('arrests.org URL yields state subdomain, county, and booking date', () => {
  const facts = factsFromUrl('https://northcarolina.arrests.org/Wake/2026/April/22/', GENE);
  assert.deepEqual(facts.state, ['NC']);
  assert.deepEqual(facts.county, ['Wake']);
  assert.deepEqual(facts.booking_dates, ['2026-04-22']);
});

test('mugshots.zone URL yields the middle name, date, and fused county+state subdomain', () => {
  const facts = factsFromUrl(
    'https://wakenc.mugshots.zone/beachak-gene-michael-mugshot-04-22-2026/',
    GENE
  );
  assert.deepEqual(facts.state, ['NC']);
  assert.deepEqual(facts.county, ['Wake']);
  assert.deepEqual(facts.middle, ['Michael']);
  assert.deepEqual(facts.booking_dates, ['2026-04-22']);
});

test('id query parameters are captured as record ids', () => {
  assert.deepEqual(
    factsFromUrl('https://www.wakencbusts.com/view-full-profile.php?id=140252', GENE).record_ids,
    ['140252']
  );
  assert.deepEqual(
    factsFromUrl('https://www.wakepublicrecords.com/sample.php?id=140252', GENE).record_ids,
    ['140252']
  );
});

test('a SERP title yields middle name, county, and date', () => {
  const facts = factsFromText(
    'BEACHAK GENE MICHAEL 04/22/2026 - Wake County Mugshots Zone',
    GENE
  );
  assert.deepEqual(facts.middle, ['Michael']);
  assert.deepEqual(facts.county, ['Wake']);
  assert.deepEqual(facts.booking_dates, ['2026-04-22']);
});

test('middle-name detection works in either name order but ignores site words', () => {
  // "LAST FIRST MIDDLE" (title style) and "first-middle-last" (slug style)
  assert.deepEqual(findMiddleNames('BEACHAK GENE MICHAEL', GENE), ['Michael']);
  assert.deepEqual(findMiddleNames('gene michael beachak', GENE), ['Michael']);
  // Site furniture next to the name must not be mistaken for a middle name.
  assert.deepEqual(findMiddleNames('beachak gene mugshot arrest records', GENE), []);
});

test('a county name next to the person is not read as a middle name', () => {
  // "GENE" and "Wake" are equally close; only the following word "County"
  // distinguishes them.
  assert.deepEqual(
    findMiddleNames('BEACHAK GENE MICHAEL 04/22/2026 - Wake County Mugshots Zone', GENE),
    ['Michael']
  );
});

test('middle-name detection needs both halves of the name nearby', () => {
  // A listing of many people: another surname's row must not donate a middle name.
  assert.deepEqual(findMiddleNames('Smith John Robert', GENE), []);
});

test('findDates normalises the spellings these sites use', () => {
  assert.deepEqual(findDates('04/22/2026'), ['2026-04-22']);
  assert.deepEqual(findDates('04-22-2026'), ['2026-04-22']);
  assert.deepEqual(findDates('2026-04-22'), ['2026-04-22']);
  assert.deepEqual(findDates('/2026/April/22/'), ['2026-04-22']);
  assert.deepEqual(findDates('April 22, 2026'), ['2026-04-22']);
  assert.deepEqual(findDates('no date here'), []);
});

test('findCounties reads one- and two-word counties', () => {
  assert.deepEqual(findCounties('Booked in Wake County jail'), ['Wake']);
  assert.deepEqual(findCounties('New Hanover County records'), ['New Hanover']);
});

test('state and county helpers normalise to the forms URLs use', () => {
  assert.equal(stateCode('nc'), 'NC');
  assert.equal(stateCode('North Carolina'), 'NC');
  assert.equal(stateCode('Nowhere'), null);
  assert.equal(stateName('NC'), 'northcarolina');
  assert.equal(countySlug('Wake County'), 'wake');
  assert.equal(countySlug('New Hanover'), 'newhanover');
});

test('facts keep every spelling variant rather than collapsing to one', () => {
  // wakencbusts says "Micheal", mugshots.zone says "Michael" — both must survive
  // so both remain searchable.
  const merged = mergeFacts(normalizeFacts({ middle: ['Micheal'] }), { middle: ['Michael'] });
  assert.deepEqual(merged.middle, ['Micheal', 'Michael']);
  // Same spelling in different case is one variant, not two.
  assert.deepEqual(mergeFacts(merged, { middle: ['MICHAEL'] }).middle, ['Micheal', 'Michael']);
});

test('corroboration requires the surname and rejects a same-first-name stranger', () => {
  const facts = normalizeFacts({ county: ['Wake'], state: ['NC'] });
  // No surname anywhere: not our person, whatever else matches.
  assert.equal(
    scoreCorroboration('Gene Sorrentino booked in Wake County', GENE, facts).confidence,
    0
  );
});

test('corroboration rises as independent facts agree', () => {
  const bare = normalizeFacts({});
  const nameOnly = scoreCorroboration('Beachak arrest record', GENE, bare).confidence;
  const withFirst = scoreCorroboration('Gene Beachak arrest record', GENE, bare).confidence;
  const rich = scoreCorroboration(
    'BEACHAK GENE MICHAEL 04/22/2026 Wake County',
    GENE,
    normalizeFacts({ county: ['Wake'], middle: ['Michael'], booking_dates: ['2026-04-22'] })
  );

  assert.ok(nameOnly > 0 && nameOnly < 0.55, 'surname alone must not clear the bar');
  assert.ok(withFirst >= 0.55, 'first + surname clears the minimum');
  assert.ok(rich.confidence > withFirst, 'agreeing facts must raise confidence');
  assert.deepEqual(Object.keys(rich.matched).sort(), [
    'booking_date',
    'county',
    'first',
    'last',
    'middle',
  ]);
});

test('dateVariants covers the formats found in titles and paths', () => {
  const variants = dateVariants('2026-04-22');
  assert.ok(variants.includes('04/22/2026'));
  assert.ok(variants.includes('2026-04-22'));
  assert.ok(variants.some((v) => v.startsWith('april 22')));
});

test('dateWindow pads around known booking dates', () => {
  // recentlybooked's search requires FromDate/ToDate, so the window is built
  // from whatever dates round A learned.
  const w = dateWindow(['2026-04-22']);
  assert.equal(w.from, '2026-04-15');
  assert.equal(w.to, '2026-04-29');

  const spread = dateWindow(['2026-04-22', '2025-01-10']);
  assert.equal(spread.from, '2025-01-03');
  assert.equal(spread.to, '2026-04-29');
});

test('dateWindow falls back to a wide range when no date is known', () => {
  // Missing a date must not skip the probe — old arrests are the whole point.
  const w = dateWindow([], new Date('2026-07-25T00:00:00Z'));
  assert.equal(w.to, '2026-07-25');
  assert.equal(w.from, '2021-07-25');
});

/* ── Shapes taken verbatim from 1,049 historical client links ───────────── */

const REMMARK = splitName('Jeffery Remmark');

test('mugshots.zone county subdomain and LAST-FIRST-MIDDLE slug', () => {
  const f = factsFromUrl(
    'https://arlingtonva.mugshots.zone/remmark-jeffery-colin-mugshot-09-28-2025/',
    REMMARK
  );
  assert.deepEqual(f.middle, ['Colin']);
  assert.deepEqual(f.county, ['Arlington']);
  assert.deepEqual(f.state, ['VA']);
  assert.deepEqual(f.booking_dates, ['2025-09-28']);
});

test('bustednewspaper record: spelled-out state, name slug, compact stamp', () => {
  const f = factsFromUrl(
    'https://bustednewspaper.com/virginia/remmark-jeffery-colin/20250928-225000/',
    REMMARK
  );
  assert.deepEqual(f.state, ['VA']);
  assert.deepEqual(f.middle, ['Colin']);
  // A spelled-out state introduces a NAME slug, not a county. Reading it as one
  // produced counties like "Remmark Jeffery Colin".
  assert.equal(f.county, undefined);
});

test('a Busted Newspaper Facebook post yields middle, county, state and date', () => {
  // 8% of historical links are Facebook, and the post slug carries everything.
  const f = factsFromUrl(
    'https://web.facebook.com/BustedNewspaperArlingtonCountyVA/posts/remmark-jeffery-colin-mugshot-2025-09-28-225000-arlington-county-virginia-arrest/811046071683169/',
    REMMARK
  );
  assert.deepEqual(f.middle, ['Colin']);
  assert.deepEqual(f.county, ['Arlington']);
  assert.deepEqual(f.state, ['VA']);
  assert.deepEqual(f.booking_dates, ['2025-09-28']);
});

test('arrests.org record yields the state but invents no county', () => {
  // "/Arrests/…" sits where a county segment would; reading it as a county gave
  // a wrong county on 197 historical links.
  const f = factsFromUrl('https://virginia.arrests.org/Arrests/Jeffery_Remmark_65771891/', REMMARK);
  assert.deepEqual(f.state, ['VA']);
  assert.equal(f.county, undefined);
  assert.deepEqual(f.record_ids, ['65771891']);
});

test('a state name is never split into a county plus a state code', () => {
  // "virginia" decomposed into county "Virgin" + state "IA" before this guard.
  const f = factsFromUrl('https://virginia.arrests.org/Arrests/x_y_1234567/', REMMARK);
  assert.deepEqual(f.state, ['VA']);
  assert.ok(!(f.county ?? []).includes('Virgin'));
});

test('recentlybooked record yields state, county and id but no stray middle name', () => {
  const f = factsFromUrl(
    'https://recentlybooked.com/VA/Arlington/JEFFERY-REMMARK~2831_2025-00004672',
    REMMARK
  );
  // One state, not one per detection rule that spotted it.
  assert.deepEqual(f.state, ['VA']);
  assert.deepEqual(f.county, ['Arlington']);
  assert.ok(f.record_ids.includes('2831_2025-00004672'));
  // Neighbouring path segments are not middle names.
  assert.equal(f.middle, undefined);
});

test('arre.st short links yield the state and record id', () => {
  const f = factsFromUrl('https://arre.st/FL-116076423/', REMMARK);
  assert.deepEqual(f.state, ['FL']);
  assert.deepEqual(f.record_ids, ['116076423']);
});

test('counties are read from slugs and camel-cased social handles', () => {
  assert.deepEqual(findCounties('x-arlington-county-virginia-arrest'), ['Arlington']);
  assert.deepEqual(findCounties('mugshots.orlando.orange.county.jail.arrests'), ['Orange']);
  assert.deepEqual(findCounties('GordonCountyCrime'), ['Gordon']);
  // Site furniture in a county-shaped position is not a county.
  assert.deepEqual(findCounties('/Arrests/Jeffery_Remmark_65771891/'), []);
});

test('compact yyyymmdd stamps parse, and long ids do not', () => {
  assert.deepEqual(findDates('/20250928-225000/'), ['2025-09-28']);
  assert.deepEqual(findDates('id=811046071683169'), []);
});

test('unlocker page fetches are metered so probe spend is visible', async () => {
  // Probes only cost money when they fall back to the unlocker; leaving that
  // unmetered would hide the entire cost of deep search.
  const source = await readFile(new URL('../lib/deep-search/fetch-page.ts', import.meta.url), 'utf8');
  assert.match(source, /reserveUsage\(\{[\s\S]*?operation: 'unlocker'/);
  // Reserved BEFORE the request, so the monthly cap can actually stop one.
  assert.ok(
    source.indexOf('reserveUsage') < source.indexOf('api.brightdata.com/request'),
    'usage must be reserved before the billed request is sent'
  );
  // Both outcomes close the event out; a failed unlocker call is still billed.
  assert.match(source, /finishUsage\([^)]*'failed'/);
  assert.match(source, /finishUsage\([^)]*'succeeded'\)/);
});

test('per-call costs are validated, not silently coerced to zero', async () => {
  const source = await readFile(
    new URL('../app/api/admin/settings/route.ts', import.meta.url),
    'utf8'
  );
  assert.match(source, /serp_cost/);
  assert.match(source, /unlocker_cost/);
  // Number.isFinite rejects "abc" instead of storing NaN, which would report a
  // month of real spend as $0.00.
  assert.match(source, /Number\.isFinite\(cost\)/);
});
