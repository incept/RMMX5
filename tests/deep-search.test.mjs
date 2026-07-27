import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  EMPTY_FACTS,
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
  normalizeLlmRow,
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

test('model rows are coerced to the promised shape', () => {
  // The live failure: asked for charges as an array, Haiku returned one string,
  // and a .join() on it threw and aborted an entire probe run.
  assert.deepEqual(normalizeLlmRow({ charges: 'DUI, no license' }).charges, [
    'DUI',
    'no license',
  ]);
  assert.deepEqual(normalizeLlmRow({ charges: ['Assault', 'Theft'] }).charges, [
    'Assault',
    'Theft',
  ]);
  // Absent, null, numeric, and object shapes all normalise instead of throwing.
  assert.deepEqual(normalizeLlmRow({}).charges, []);
  assert.deepEqual(normalizeLlmRow({ charges: null }).charges, []);
  assert.deepEqual(normalizeLlmRow({ charges: [{ x: 1 }] }).charges, []);
  assert.deepEqual(normalizeLlmRow({ charges: 42 }).charges, []);
});

test('model row scalars are trimmed strings, never objects', () => {
  const row = normalizeLlmRow({
    url: '  https://example.com/x  ',
    county: 'Wake',
    state: { nested: 'nope' },
    record_id: 140252,
  });
  assert.equal(row.url, 'https://example.com/x');
  assert.equal(row.county, 'Wake');
  assert.equal(row.state, undefined, 'an object must not leak through as a string');
  assert.equal(row.record_id, '140252');
});

test('a single unreadable probe page cannot abort the whole run', async () => {
  const source = await readFile(new URL('../lib/deep-search/index.ts', import.meta.url), 'utf8');
  // rowsFromPage is wrapped, so one bad page skips instead of discarding every
  // candidate the earlier probes already found.
  assert.match(source, /try \{[\s\S]{0,400}rowsFromPage\([\s\S]{0,400}\} catch/);
});

test('a blocked site is reached through a site:-restricted SERP query', async () => {
  // arrests.org is 20.5% of historical links and answers a datacentre IP with a
  // Cloudflare challenge. Google has already crawled it, so the records stay
  // reachable without touching the host.
  const source = await readFile(new URL('../lib/deep-search/index.ts', import.meta.url), 'utf8');
  assert.match(source, /site:\$\{domain\}/);
  // Bounded, because each fallback costs a SERP request.
  assert.match(source, /MAX_SERP_FALLBACKS/);
  // Corroboration still applies: a site: query returns near misses too.
  assert.match(source, /scored\.confidence < MIN_CONFIDENCE/);
});

test('record ids pivot to sibling sites in the same network', async () => {
  const source = await readFile(new URL('../lib/deep-search/index.ts', import.meta.url), 'utf8');
  assert.match(source, /record_url_template/);
  // A derived URL is a lead, not a finding: nobody has loaded the page yet, so
  // it must score below a fetched hit.
  assert.match(source, /confidence: 0\.7/);
});

test('the migration wires arrests.org and the Wake network for fallback and pivots', async () => {
  const sql = await readFile(
    new URL('../supabase/migrations/0013_serp_fallback_and_record_pivots.sql', import.meta.url),
    'utf8'
  );
  assert.match(sql, /serp_fallback/);
  assert.match(sql, /'arrests\.org'/);
  // The confirmed shared id from the client's own example.
  assert.match(sql, /wakencbusts\.com\/view-full-profile\.php\?id=\{record_id\}/);
  assert.match(sql, /wakepublicrecords\.com\/sample\.php\?id=\{record_id\}/);
  // The per-county N1 network must NOT get a pivot template: each county site
  // has its own id space, so a Wake id would build a confident, wrong Palm
  // Beach URL.
  assert.doesNotMatch(sql, /county_slug\}publicrecords\.com\/sample/);
});

test('the site: fallback query is not an exact phrase', async () => {
  // These sites render "BEACHAK GENE MICHAEL" or "Beachak, Gene", so a quoted
  // "Gene Beachak" can match nothing. Precision comes from corroboration.
  const source = await readFile(new URL('../lib/deep-search/index.ts', import.meta.url), 'utf8');
  assert.match(source, /site:\$\{domain\} \$\{name\.first\} \$\{name\.last\}/);
});

test('unlocker retries transient errors but never a policy refusal', async () => {
  // The account log distinguishes these clearly: bustednewspaper.com shows
  // ERR_HTTP2_PROTOCOL_ERROR interleaved with successes (retry pays), while
  // arrests.org returns policy_20000 every time (retrying burns time on a
  // decision already made).
  const source = await readFile(new URL('../lib/deep-search/fetch-page.ts', import.meta.url), 'utf8');
  assert.match(source, /err_http2_protocol_error/);
  assert.match(source, /before_session_error/);
  assert.match(source, /POLICY_ERROR\.test\(failureSignal\)\) break/);
  // A policy refusal must say what to do, since no retry or zone change fixes it.
  assert.match(source, /compliance team/);
});

test('spend is priced off successful requests only', async () => {
  // BrightData documents "you are charged only for successful requests", so
  // pricing every attempt overstated the bill.
  const source = await readFile(new URL('../lib/usage.ts', import.meta.url), 'utf8');
  assert.match(source, /Object\.entries\(succeeded\)/);
  // Failures stay visible, as health rather than cost.
  assert.match(source, /_failed: failed/);
});

test('social domains are documented as unsupported probe targets', async () => {
  // Web Unlocker explicitly excludes social networks, so nobody should add
  // facebook.com as a probe site; social coverage is the SERP classifier's job.
  const source = await readFile(new URL('../lib/deep-search/fetch-page.ts', import.meta.url), 'utf8');
  assert.match(source, /social networks are explicitly outside/i);
});

test('a policy-blocked domain is flagged for SERP instead of retried forever', async () => {
  // policy_20000 is a standing decision about the domain, so probing it again
  // next run would waste the same call.
  const source = await readFile(new URL('../lib/deep-search/index.ts', import.meta.url), 'utf8');
  assert.match(source, /outcome\.policyBlocked/);
  assert.match(source, /serp_fallback: true/);
});

test('the migration routes arrests.org through SERP rather than the unlocker', async () => {
  const sql = await readFile(
    new URL('../supabase/migrations/0014_probe_render_flag.sql', import.meta.url),
    'utf8'
  );
  // Direct probing off, SERP discovery on — its search path is fine, BrightData
  // just will not fetch the domain.
  assert.match(sql, /set active = false/);
  assert.match(sql, /serp_fallback = true/);
  assert.match(sql, /policy_20000/);
  assert.match(sql, /needs_render/);
});

test('SERP fallback slots go by priority, not row order', async () => {
  // The bug this pins: ordering by scope put 'national' ahead of 'state', so
  // arre.st (19 links) consumed a slot while arrests.org (20.5% of every
  // historical link) was cut off by the per-run cap.
  const source = await readFile(new URL('../lib/deep-search/index.ts', import.meta.url), 'utf8');
  assert.match(source, /\.sort\(\(a, b\) => \(a\.site\?\.priority \?\? 100\) - \(b\.site\?\.priority \?\? 100\)\)/);
  // One query per network: mirrors return the same records.
  assert.match(source, /usedFamilies/);
});

test('a priority site missing from both indexes is recorded as unindexed', async () => {
  // Index lag is the SERP route's real weakness. Both engines now run on every
  // fallback, so an empty result means neither index has the page.
  const source = await readFile(new URL('../lib/deep-search/index.ts', import.meta.url), 'utf8');
  assert.match(source, /!results\.length && \(site\?\.priority \?\? 100\) <= 20/);
  assert.match(source, /unindexedPrioritySites\.push\(domain\)/);
});

test('a page missing from both indexes flags the contact for a later re-run', async () => {
  const source = await readFile(new URL('../lib/deep-search/index.ts', import.meta.url), 'utf8');
  assert.match(source, /unindexedPrioritySites/);
  // Reuses search_flag, so it appears in the grid's existing Flagged view.
  assert.match(source, /Not yet indexed on/);
});

test('arre.st is no longer searched separately from arrests.org', async () => {
  const sql = await readFile(
    new URL('../supabase/migrations/0015_fallback_priority.sql', import.meta.url),
    'utf8'
  );
  assert.match(sql, /set serp_fallback = false[\s\S]*?where domain = 'arre\.st'/);
  // arrests.org must outrank everything for the scarce slots.
  assert.match(sql, /set priority = 10 where domain = 'arrests\.org'/);
});

test('date-addressed pages are derived from county and booking date', async () => {
  // northcarolina.arrests.org/Wake/2026/April/22/ is a daily county ROSTER, so a
  // name search can miss it even when Google has it indexed. County plus date
  // names the URL outright, which is the only route on a host BrightData will
  // not fetch — and it costs no request at all.
  const source = await readFile(new URL('../lib/deep-search/index.ts', import.meta.url), 'utf8');
  assert.match(source, /buildDateUrl/);
  assert.match(source, /MONTH_NAMES/);
  const sql = await readFile(
    new URL('../supabase/migrations/0016_date_url_derivation.sql', import.meta.url),
    'utf8'
  );
  // The exact observed shape: state subdomain, capitalised county, month name.
  assert.match(sql, /\{state_name\}\.arrests\.org\/\{county\}\/\{yyyy\}\/\{month_name\}\/\{dd\}/);
});

test('every SERP fallback queries both engines and merges them', async () => {
  // The two crawl these sites on different schedules, so each holds records the
  // other misses — the same reason the auto-search queries both.
  const source = await readFile(new URL('../lib/deep-search/index.ts', import.meta.url), 'utf8');
  assert.match(source, /const engines: SearchEngine\[\] = \['google', 'bing'\]/);
  assert.match(source, /mergeSerpResults\(lists\)/);
});

test('arrests.org indexes BOTH a per-person record and a daily roster', () => {
  // Google returns either shape, and they need different routes:
  //   /Arrests/Gene_Beachak_67642359/  -> the name is in the URL, so the
  //     site: name search finds it, and the numeric id parses out
  //   /Wake/2026/April/22/             -> addressed by county and date, so it
  //     is derived from facts rather than searched for
  const GENE = splitName('Gene Beachak');

  const record = factsFromUrl(
    'https://northcarolina.arrests.org/Arrests/Gene_Beachak_67642359/',
    GENE
  );
  assert.deepEqual(record.state, ['NC']);
  assert.deepEqual(record.record_ids, ['67642359']);
  // Surname + first name in the URL clears the corroboration floor on their own,
  // before any help from the SERP title or snippet.
  const scored = scoreCorroboration(
    'https://northcarolina.arrests.org/Arrests/Gene_Beachak_67642359/',
    GENE,
    normalizeFacts({ county: ['Wake'], state: ['NC'] })
  );
  assert.ok(scored.confidence >= 0.55, 'a record URL must clear the floor unaided');

  const roster = factsFromUrl('https://northcarolina.arrests.org/Wake/2026/April/22/', GENE);
  assert.deepEqual(roster.county, ['Wake']);
  assert.deepEqual(roster.booking_dates, ['2026-04-22']);
  // No name anywhere in a roster URL, which is exactly why it is derived from
  // county + date instead of scored like a search hit.
  assert.equal(roster.middle, undefined);
});

test('a site that had a hit also yields its "all arrests" search link', async () => {
  // A record page proves ONE booking; the site's own search shows whether the
  // person has more. Derivable from the name alone, so it works even on a host
  // we cannot fetch — the operator's browser has no policy problem.
  const source = await readFile(new URL('../lib/deep-search/index.ts', import.meta.url), 'utf8');
  assert.match(source, /sitesWithHits/);
  assert.match(source, /kind: 'site_search'/);
  // Only for sites that actually produced evidence, so it is not noise.
  assert.match(source, /!sitesWithHits\.has\(site\.domain\)\) continue/);
  // Zero confidence: a tool link, not a scored finding, so it sorts last.
  assert.match(source, /confidence: 0,/);
});

test('a search view cannot be accepted into a removal link slot', async () => {
  // Link slots hold pages to be REMOVED. A search URL is not removable content,
  // so those rows offer Done instead of Add.
  const source = await readFile(new URL('../components/ContactPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /c\.matched_facts\?\.kind === 'site_search'/);
  assert.match(source, /search view/);
});

test('the arrests.org search link is the short human-facing form', async () => {
  const sql = await readFile(
    new URL('../supabase/migrations/0017_site_search_links.sql', import.meta.url),
    'utf8'
  );
  // The TEMPLATE must be the short form. The surrounding comment mentions
  // fpartial deliberately, to record why it was dropped.
  const template = /set search_template = '([^']+)'/.exec(sql)?.[1];
  assert.equal(template, 'https://{state_name}.arrests.org/search.php?fname={first}&lname={last}');
});

test('fallback engines run in parallel on a tighter deadline', async () => {
  // Sequentially, a Bing timeout added its full 60s to the run for every
  // fallback domain — four domains of that is minutes spent waiting.
  const source = await readFile(new URL('../lib/deep-search/index.ts', import.meta.url), 'utf8');
  assert.match(source, /Promise\.allSettled\(\s*engines\.map/);
  assert.match(source, /FALLBACK_TIMEOUT_MS/);
  // One engine surviving is enough.
  assert.match(source, /if \(!lists\.length\) continue;/);

  const brightdata = await readFile(
    new URL('../lib/integrations/brightdata.ts', import.meta.url),
    'utf8'
  );
  assert.match(brightdata, /AbortSignal\.timeout\(opts\?\.timeoutMs \?\? 60_000\)/);
});

test('the proxy tier sits between the free fetch and the paid unlocker', async () => {
  // Measured: mugshots.zone and bustednewspaper.com (35.4% of historical client
  // links between them) drop the socket from a datacentre IP but serve real
  // search results through an ISP-classified exit. Direct still runs first
  // because it is free and routes through nobody else.
  const source = await readFile(new URL('../lib/deep-search/fetch-page.ts', import.meta.url), 'utf8');
  const direct = source.indexOf("browserFetch(url, 'direct'");
  const proxy = source.indexOf("browserFetch(url, 'proxy'");
  const unlocker = source.indexOf('reserveUsage({');
  assert.ok(direct > -1 && proxy > -1 && unlocker > -1, 'all three tiers present');
  assert.ok(direct < proxy, 'direct is attempted before the proxy');
  assert.ok(proxy < unlocker, 'the proxy is attempted before the billable unlocker');
});

test('the proxy tier uses undici fetch, not the global one', async () => {
  // Node's global fetch runs on its INTERNAL undici and rejects a dispatcher
  // built by the npm package with UND_ERR_INVALID_ARG, so every proxied request
  // fails while looking like a proxy fault.
  const source = await readFile(new URL('../lib/deep-search/fetch-page.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ ProxyAgent, fetch as undiciFetch \} from 'undici'/);
  assert.match(source, /await undiciFetch\(url, \{[\s\S]*?dispatcher,/);
});

test('a misconfigured proxy cannot take down the unlocker fallback', async () => {
  const source = await readFile(new URL('../lib/deep-search/fetch-page.ts', import.meta.url), 'utf8');
  assert.match(source, /proxy tier unavailable/);
});

test('the proxy is not offered as a fix for arrests.org', async () => {
  // arrests.org refuses on the TLS fingerprint, which a CONNECT tunnel does not
  // change: measured 403 both direct and proxied, from every browser UA tried.
  // Recording it so the proxy is not mistaken for a route to that host.
  const source = await readFile(new URL('../lib/deep-search/fetch-page.ts', import.meta.url), 'utf8');
  assert.match(source, /JA3\/JA4|fingerprints the handshake/);
  // The route to that host is real Chrome, not the proxy.
  assert.match(source, /which is why the browser tier exists/);
});

test('the browser tier runs before the billable unlocker', async () => {
  // Chrome costs CPU and memory, not money, so it goes ahead of the unlocker —
  // and it is the only tier that reaches a host blocking on TLS fingerprint.
  const source = await readFile(new URL('../lib/deep-search/fetch-page.ts', import.meta.url), 'utf8');
  const browser = source.indexOf('fetchWithBrowser(url');
  const unlocker = source.indexOf('reserveUsage({');
  assert.ok(browser > -1 && unlocker > -1);
  assert.ok(browser < unlocker, 'browser is tried before the billable unlocker');
});

test('a TLS-fingerprinted host skips the two tiers that always fail it', async () => {
  // Both HTTP tiers cost two attempts on a 20s timeout, every time, for nothing.
  const source = await readFile(new URL('../lib/deep-search/fetch-page.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(!opts\?\.needsBrowser\) \{/);
  const index = await readFile(new URL('../lib/deep-search/index.ts', import.meta.url), 'utf8');
  assert.match(index, /needsBrowser: site\.needs_browser/);
});

test('the headless User-Agent is overridden, which is what makes the tier work', async () => {
  // Chrome's own headless UA says "HeadlessChrome" and is refused on sight:
  // measured 403 with the default UA and 200 with a real one, same browser.
  const source = await readFile(new URL('../lib/deep-search/browser.ts', import.meta.url), 'utf8');
  assert.match(source, /setUserAgent\(BROWSER_UA\)/);
  assert.doesNotMatch(source, /HeadlessChrome\/\d/, 'must not ship a headless UA');
});

test('the browser tier cannot leak processes', async () => {
  // This host was taken down once by processes that were started and never
  // reaped, and a stray Chrome is heavier than a stray fetch.
  const source = await readFile(new URL('../lib/deep-search/browser.ts', import.meta.url), 'utf8');
  assert.match(source, /IDLE_SHUTDOWN_MS/, 'closes itself when idle');
  assert.match(source, /MAX_CONCURRENT_PAGES/, 'bounds concurrent tabs');
  assert.match(source, /} finally \{/, 'pages are closed on the failure path too');
  assert.match(source, /await context\?\.close\(\)/, 'contexts are closed, not just pages');
  // A single shared browser, not one per call.
  assert.match(source, /if \(!browserPromise\)/);
});

test('subresources are refused so probe pages stay cheap', async () => {
  // Mugshot pages are mostly photographs; we only ever read the markup.
  const source = await readFile(new URL('../lib/deep-search/browser.ts', import.meta.url), 'utf8');
  assert.match(source, /\['image', 'font', 'media', 'stylesheet'\]/);
});

test('the page cap holds when a slot is released and taken in the same tick', async () => {
  // Regression: releaseSlot used to decrement and then resolve a waiter, but
  // resolve() only queues the continuation. Anything calling acquireSlot before
  // that microtask ran saw a free slot and took it, so both proceeded and a cap
  // of 2 was reachable at 3. The slot is now handed over without the count ever
  // dipping. Asserted on source because the module needs Supabase settings.
  const source = await readFile(new URL('../lib/deep-search/browser.ts', import.meta.url), 'utf8');
  const release = source.slice(source.indexOf('function releaseSlot'));
  const shift = release.indexOf('waiters.shift()');
  const decrement = release.indexOf('activePages = Math.max(0, activePages - 1)');
  assert.ok(shift > -1 && decrement > -1);
  assert.ok(shift < decrement, 'the waiter handoff must come before any decrement');
  // And the waiter must not re-increment on resume.
  const acquire = source.slice(
    source.indexOf('async function acquireSlot'),
    source.indexOf('function releaseSlot')
  );
  assert.doesNotMatch(
    acquire.slice(acquire.indexOf('waiters.push')),
    /activePages \+= 1/,
    'a resumed waiter must not add to the count again'
  );
});

test('a failed launch only clears the browser slot if it still owns it', async () => {
  // Otherwise closeBrowser during a pending launch lets a late rejection discard
  // a newer, live browser and start a third — two Chrome processes at once.
  const source = await readFile(new URL('../lib/deep-search/browser.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(browserPromise === launching\) browserPromise = null;\s*\n\s*throw e;/);
});

test('one confirmed link seeds the facts a run would otherwise have to discover', () => {
  // A URL only reaches a link slot when a human accepted it, so it is a verified
  // sighting. This one carries everything round B needs, at no cost.
  const seeded = factsFromUrl(
    'https://wakenc.mugshots.zone/beachak-gene-michael-mugshot-04-22-2026/',
    GENE
  );
  assert.deepEqual(seeded.county, ['Wake']);
  assert.deepEqual(seeded.state, ['NC']);
  assert.deepEqual(seeded.middle, ['Michael']);
  assert.deepEqual(seeded.booking_dates, ['2026-04-22']);
});

test('confirmed facts outrank scraped ones for the value actually searched', () => {
  // Probe URLs are built from facts.county[0] / facts.state[0] and each key is
  // capped, so precedence here IS precedence in what gets requested.
  let pinned = mergeFacts({ ...EMPTY_FACTS }, { state: ['NC'] });
  pinned = mergeFacts(
    pinned,
    factsFromUrl('https://wakenc.mugshots.zone/beachak-gene-michael-mugshot-04-22-2026/', GENE)
  );
  const facts = mergeFacts(pinned, normalizeFacts({ county: ['Durham'], middle: ['Micheal'] }));

  assert.equal(facts.county[0], 'Wake', 'the confirmed county is the one probed');
  assert.equal(facts.middle[0], 'Michael', 'the confirmed spelling leads');
  // The disagreeing values survive as alternatives rather than being discarded:
  // sites really do spell the middle name both ways.
  assert.deepEqual(facts.county, ['Wake', 'Durham']);
  assert.deepEqual(facts.middle, ['Michael', 'Micheal']);
});

test('a confirmed out-of-state link legitimises records from that state', () => {
  // The old check compared against one seed state, so a client with a real West
  // Virginia link had their WV records thrown away as a same-name stranger.
  let pinned = mergeFacts({ ...EMPTY_FACTS }, { state: ['NC'] });
  pinned = mergeFacts(
    pinned,
    factsFromUrl('https://westvirginia.arrests.org/Kanawha/2025/June/03/', GENE)
  );
  const pinnedStates = pinned.state;
  const conflicts = (rows) =>
    pinnedStates.length > 0 && rows.length > 0 && !rows.some((s) => pinnedStates.includes(s));

  assert.deepEqual(pinnedStates, ['NC', 'WV']);
  assert.equal(conflicts(['WV']), false, 'a state we have a confirmed link in is accepted');
  assert.equal(conflicts(['TX']), true, 'an unrelated state is still rejected');
  assert.equal(conflicts([]), false, 'no state on the row is not a conflict');
});

test('empty link slots contribute nothing', async () => {
  // contact_links rows exist from creation with url = '', so most are blank.
  const source = await readFile(new URL('../lib/deep-search/index.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(!slotUrl\) continue;/);
  assert.match(source, /mergeFacts\(pinned, normalizeFacts\(contact\.search_facts\)\)/);
});

test('a rejected enqueue is logged before it is thrown', async () => {
  // The database rejected deep_search with 23514 (kind missing from
  // job_queue_kind_check) and it left no row, no debug entry, and a 500 with an
  // unparseable body. The clear error existed the whole time; three layers hid
  // it. Only 23505 may be swallowed, and only as the duplicate case.
  const source = await readFile(new URL('../lib/job-queue.ts', import.meta.url), 'utf8');
  const enqueue = source.slice(source.indexOf('export async function enqueueJob'));
  const body = enqueue.slice(0, enqueue.indexOf('\n}'));
  const logAt = body.indexOf('logDebug');
  const throwAt = body.indexOf('throw new Error');
  assert.ok(logAt > -1, 'a failed enqueue is logged');
  assert.ok(logAt < throwAt, 'it is logged BEFORE throwing, so the trace survives');
  // The constraint case names itself, because "violates check constraint" alone
  // does not tell an operator that a migration is missing.
  assert.match(body, /23514/);
  assert.match(body, /job_queue_kind_check/);
  // A logging failure must not replace the error being reported.
  assert.match(body, /\}\)\.catch\(\(\) => \{\}\);/);
});

test('the deep search button always stops spinning', async () => {
  // setBusy(null) sat after `await res.json()`, so a non-JSON error body threw
  // first and the spinner never cleared: a failed request presented as a hang.
  const source = await readFile(
    new URL('../components/ContactPanel.tsx', import.meta.url),
    'utf8'
  );
  const fn = source.slice(source.indexOf('async function runDeepSearch'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(body, /finally \{\s*setBusy\(null\);/);
  assert.match(body, /res\.json\(\)\.catch\(/, 'an unparseable error body is tolerated');
  assert.match(body, /HTTP \$\{res\.status\}/, 'the status is shown when there is no message');
});

test('migration numbers are unique', async () => {
  // Two 0020s shipped from parallel branches. A prefix-tracking tool can skip
  // one, and the skipped one here was what disabled deep search entirely.
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(new URL('../supabase/migrations/', import.meta.url));
  const numbers = files.filter((f) => f.endsWith('.sql')).map((f) => f.slice(0, 4));
  const dupes = numbers.filter((n, i) => numbers.indexOf(n) !== i);
  assert.deepEqual(dupes, [], `duplicate migration prefixes: ${dupes.join(', ')}`);
});

test('a failed deep-search enqueue answers with JSON the operator can read', async () => {
  // A bare 500 carries no body, so the UI could only say "HTTP 500" while the
  // cause sat in a server log nobody can reach from the CRM. The route now
  // reports its own failure and logs it against the contact.
  const source = await readFile(
    new URL('../app/api/contacts/[id]/deep-search/route.ts', import.meta.url),
    'utf8'
  );
  assert.match(source, /catch \(e\) \{/);
  assert.match(source, /source: 'deep-search:enqueue'/);
  assert.match(source, /contactId: id/, 'the log is attributable to the contact');
  assert.match(
    source,
    /NextResponse\.json\(\s*\{ error: `Could not start deep search: \$\{message\}` \}/,
    'the real message reaches the client'
  );
  // The enqueue itself must be inside the guarded region.
  const tryAt = source.indexOf('try {');
  const enqueueAt = source.indexOf('await enqueueJob(');
  const catchAt = source.indexOf('} catch (e) {');
  assert.ok(tryAt < enqueueAt && enqueueAt < catchAt, 'enqueueJob runs inside the try');
});

test('every API route records its own failures', async () => {
  // The gap that hid the deep-search outage: routes caught errors and returned
  // a message while recording nothing, so a fault left a status code and no
  // trace. Tracking endpoints are exempt from RETURNING an error — they must
  // still answer with a pixel or redirect — but not from logging one.
  const { readdir } = await import('node:fs/promises');
  const dir = new URL('../app/api/', import.meta.url);
  const walk = async (d) => {
    const out = [];
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), d);
      if (entry.isDirectory()) out.push(...(await walk(child)));
      else if (entry.name === 'route.ts') out.push(child);
    }
    return out;
  };
  const routes = await walk(dir);
  assert.ok(routes.length >= 20, 'found the routes');

  const silent = [];
  for (const route of routes) {
    const source = await readFile(route, 'utf8');
    const reports = source.includes('apiFailure(') || source.includes('logDebug(');
    if (!reports) silent.push(route.pathname.split('/app/api/')[1]);
  }
  assert.deepEqual(silent, [], `routes that can fail silently: ${silent.join(', ')}`);
});

test('logDebug notices when its own insert is rejected', async () => {
  // The client RETURNS errors instead of throwing, so an unchecked insert would
  // slip past the catch and log nothing, forever, with no symptom at all.
  const source = await readFile(new URL('../lib/debug-log.ts', import.meta.url), 'utf8');
  assert.match(source, /const \{ error \} = await createAdminClient\(\)/);
  assert.match(source, /INSERT FAILED/);
  // The fallback must be the console: the database is the thing that just failed.
  assert.match(source, /console\.error\(\s*`\[debug-log\] INSERT FAILED/);
});

test('deliberate 4xx are not logged as faults', async () => {
  // A rejected form submission is not a fault, and logging every one would bury
  // the errors that matter.
  const source = await readFile(new URL('../lib/api-errors.ts', import.meta.url), 'utf8');
  assert.match(source, /const deliberate = typeof \(error as \{ status\?: number \} \| null\)\?\.status === 'number'/);
  assert.match(source, /if \(!deliberate \|\| response\.status >= 500\)/);
  // Postgres codes are the usual answer, so they must survive into the log.
  assert.match(source, /code: \(error as \{ code\?: string \}/);
});

test('puppeteer-core is never a static import', async () => {
  // A top-level import put a heavy optional dependency in the module graph of
  // everything downstream — including the queue, and so the route that only
  // wanted to insert a row. When the bundler could not materialise it on the
  // host ("open EEXIST") the chain died at LOAD time, before any handler ran,
  // where no try/catch could reach it and nothing could be logged.
  const source = await readFile(new URL('../lib/deep-search/browser.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /^import puppeteer[ ,]/m,
    'puppeteer-core must not be imported for value at module scope'
  );
  assert.match(source, /import \{ type Browser, type Page \} from 'puppeteer-core'/);
  assert.match(source, /await import\('puppeteer-core'\)/, 'loaded lazily, where it is used');

  // The singleton must still be claimed synchronously: awaiting the import
  // before assigning would let two callers each launch their own Chrome.
  assert.match(source, /const launching = \(async \(\) => \{/, 'wrapped so assignment is synchronous');
  const fn = source.slice(source.indexOf('async function getBrowser'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(
    body.indexOf('browserPromise = launching;') > body.indexOf("await import('puppeteer-core')"),
    'the assignment follows the IIFE rather than awaiting it'
  );
});

test('puppeteer-core is declared as a server external package', async () => {
  // Otherwise the bundler tries to materialise it at runtime, which is the
  // failure above. nodemailer was already declared for the same reason.
  const config = await readFile(new URL('../next.config.ts', import.meta.url), 'utf8');
  assert.match(config, /serverExternalPackages: \[[^\]]*'puppeteer-core'/);
});

test('clearing links removes what actually makes a re-run repeat itself', async () => {
  // The visible list is not what causes a repeat. Two things persist and must go
  // with it: dismissed candidates suppress their URL forever, and the hourly
  // dedupe key blocks a fresh enqueue. Facts are NOT among them any more — they
  // are cleared per field, so a wrong county can go without taking a correct
  // middle name and date with it.
  const source = await readFile(
    new URL('../app/api/contacts/[id]/candidates/route.ts', import.meta.url),
    'utf8'
  );
  const fn = source.slice(source.indexOf('export async function DELETE'));
  const body = fn.slice(0, fn.indexOf('\nexport async function PATCH'));

  assert.match(body, /\.in\('status', \['new', 'rejected'\]\)/, 'clears dismissed rows too');
  assert.match(body, /\.eq\('kind', 'deep_search'\)[\s\S]*?\.neq\('status', 'processing'\)/, 'frees the dedupe key');
  // Accepted candidates are the provenance for filled slots and must survive.
  assert.doesNotMatch(body, /'accepted'/, 'accepted rows are never in the delete filter');
  assert.doesNotMatch(body, /contact_links/, 'link slots are never touched');
});

test('clearing is refused while a deep search is running', async () => {
  // Otherwise the live run inserts candidates after the delete and reinstates
  // the facts just reset, leaving a half-state nobody asked for.
  const source = await readFile(
    new URL('../app/api/contacts/[id]/candidates/route.ts', import.meta.url),
    'utf8'
  );
  const fn = source.slice(source.indexOf('export async function DELETE'));
  const body = fn.slice(0, fn.indexOf('\nexport async function PATCH'));
  assert.match(body, /\.eq\('status', 'processing'\)/);
  assert.match(body, /status: 409/);
  // And it is admin-only, matching the deep-search route that creates the data.
  assert.match(body, /await requireAdmin\(\)/);
});

// --- Human-confirmed truth (facts + links) ---------------------------------

test('confirming a fact stores it in the normalised form the engine compares', async () => {
  const { addConfirmedFact } = await import('../lib/deep-search/confirmed.ts');
  // State is uppercased, a date is coerced to ISO — same normalisation the
  // scraped facts go through, so a confirmed value actually matches.
  assert.deepEqual(addConfirmedFact({}, 'state', 'nc').state, ['NC']);
  assert.deepEqual(addConfirmedFact({}, 'booking_dates', '04/22/2026').booking_dates, ['2026-04-22']);
  // Empty input is a no-op, not a blank entry.
  assert.deepEqual(addConfirmedFact({ county: ['Wake'] }, 'county', '   ').county, ['Wake']);
});

test('unconfirming a fact evicts the wrong value case-insensitively', async () => {
  const { removeConfirmedFact } = await import('../lib/deep-search/confirmed.ts');
  // This is the eviction the old accumulate-only model lacked: correcting a
  // fact drops it instead of leaving it to keep steering probes.
  const after = removeConfirmedFact({ county: ['Wake', 'Durham'] }, 'county', 'wake');
  assert.deepEqual(after.county, ['Durham']);
  // Removing something not present changes nothing.
  assert.deepEqual(removeConfirmedFact({ state: ['NC'] }, 'state', 'TX').state, ['NC']);
});

test('confirming a link folds its URL facts into the same store as a fact', async () => {
  const { confirmFactsFromUrl } = await import('../lib/deep-search/confirmed.ts');
  // Both origins converge: a confirmed link is worth exactly the facts its URL
  // encodes, so it lands where a confirmed fact would.
  const facts = confirmFactsFromUrl(
    {},
    'https://wakenc.mugshots.zone/beachak-gene-michael-mugshot-04-22-2026/',
    GENE
  );
  assert.deepEqual(facts.county, ['Wake']);
  assert.deepEqual(facts.state, ['NC']);
  assert.deepEqual(facts.middle, ['Michael']);
  assert.deepEqual(facts.booking_dates, ['2026-04-22']);
});

test('only real fact fields can be confirmed', async () => {
  const { isConfirmableKey } = await import('../lib/deep-search/confirmed.ts');
  assert.equal(isConfirmableKey('county'), true);
  assert.equal(isConfirmableKey('state'), true);
  assert.equal(isConfirmableKey('name'), false, 'name is on the contact, not a search fact');
  assert.equal(isConfirmableKey('__proto__'), false);
  assert.equal(isConfirmableKey(undefined), false);
});

test('a run seeds confirmed facts at the very top of precedence', async () => {
  // Highest authority: a human said so. Merged before the contact state and slot
  // links, so facts.county[0]/state[0] — which build the probe URLs — come from
  // the confirmed set when one exists.
  const source = await readFile(new URL('../lib/deep-search/index.ts', import.meta.url), 'utf8');
  const seedAt = source.indexOf('pinned = mergeFacts(pinned, normalizeFacts(contact.confirmed_facts))');
  const stateAt = source.indexOf('if (seedState) pinned = mergeFacts(pinned, { state: [seedState] })');
  assert.ok(seedAt > -1, 'confirmed_facts is seeded');
  assert.ok(seedAt < stateAt, 'confirmed facts merge before the contact-record state');
  // Both entry points (a full run and the SERP classifier) must agree.
  assert.equal(
    (source.match(/normalizeFacts\(contact\??\.confirmed_facts\)/g) ?? []).length,
    2,
    'both seed paths merge confirmed_facts'
  );
});

test('confirmed things are exempt from Clear results', async () => {
  const route = await readFile(
    new URL('../app/api/contacts/[id]/candidates/route.ts', import.meta.url),
    'utf8'
  );
  const del = route.slice(route.indexOf('export async function DELETE'), route.indexOf('export async function PATCH'));
  // Clear deletes only new/rejected candidates — confirmed and accepted survive.
  assert.match(del, /\.in\('status', \['new', 'rejected'\]\)/);
  // It touches neither fact store: confirmed is truth, and learned facts now
  // have their own per-field controls.
  assert.doesNotMatch(del, /confirmed_facts/, 'Clear must not touch confirmed_facts');
  assert.doesNotMatch(del, /search_facts/, 'Clear is scoped to links now');
});

test('confirm actions are admin-only and a search view cannot be confirmed', async () => {
  const route = await readFile(
    new URL('../app/api/contacts/[id]/candidates/route.ts', import.meta.url),
    'utf8'
  );
  // Each confirm branch re-checks admin (asserting durable truth, like Clear).
  for (const marker of ["action === 'confirm_fact'", "action === 'confirm_url'", "action === 'confirm'"]) {
    const at = route.indexOf(marker);
    assert.ok(at > -1, `${marker} exists`);
    assert.match(route.slice(at, at + 400), /requireAdmin\(\)/, `${marker} is admin-gated`);
  }
  assert.match(route, /A search view is not a record page and cannot be confirmed/);
});

// --- Trestle reverse-phone enrichment --------------------------------------

test('a Trestle response yields a name and a city/state pair', async () => {
  const { parsePhoneIdentity } = await import('../lib/integrations/trestle-parse.ts');
  const id = parsePhoneIdentity({
    is_valid: true,
    line_type: 'Mobile',
    owners: [
      {
        name: 'Gene Beachak',
        firstname: 'Gene',
        lastname: 'Beachak',
        addresses: [{ city: 'Raleigh', state_code: 'NC', postal_code: '27601' }],
      },
    ],
  });
  assert.equal(id.name, 'Gene Beachak');
  assert.equal(id.city, 'Raleigh');
  assert.equal(id.state, 'NC');
});

test('a half-address is treated as no address', async () => {
  // A city without its state cannot narrow a search, and can point it at the
  // wrong state entirely — worse than having no location at all.
  const { parsePhoneIdentity } = await import('../lib/integrations/trestle-parse.ts');
  const id = parsePhoneIdentity({
    owners: [{ name: 'Gene Beachak', addresses: [{ city: 'Raleigh' }] }],
  });
  assert.equal(id.name, 'Gene Beachak');
  assert.equal(id.city, null);
  assert.equal(id.state, null);
});

test('parsing never throws on an unexpected shape', async () => {
  // This runs inside a queue worker: a field rename must degrade to "no result",
  // not take the job down.
  const { parsePhoneIdentity } = await import('../lib/integrations/trestle-parse.ts');
  for (const shape of [{}, { owners: [] }, { owners: null }, { owners: [{}] }, null, undefined]) {
    const id = parsePhoneIdentity(shape);
    assert.equal(id.name, null);
    assert.equal(id.city, null);
  }
});

test('a name assembles from first/last when no full name is given', async () => {
  const { parsePhoneIdentity } = await import('../lib/integrations/trestle-parse.ts');
  const id = parsePhoneIdentity({
    owners: [{ firstname: 'Gene', lastname: 'Beachak', addresses: [] }],
  });
  assert.equal(id.name, 'Gene Beachak');
});

test('enrichment only ever fills blanks', async () => {
  // A value a person gave you outranks a data provider's guess — the same
  // precedence the search uses for confirmed facts. The lone exception is the
  // "Caller +1919…" placeholder, which is a label rather than information.
  const source = await readFile(new URL('../lib/enrichment.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(needsName && identity\.name\)/);
  assert.match(source, /if \(!contact\.city\?\.trim\(\)\)/);
  assert.match(source, /if \(!contact\.state\?\.trim\(\)\)/);
  // The "Caller +1919…" label is the one value enrichment may overwrite.
  assert.match(source, /function isPlaceholderName/, 'placeholder names are recognised');
  assert.match(source, /caller/i);
  // And it returns early rather than spending a lookup it cannot use.
  assert.match(source, /if \(!needsName && !needsLocation\)/);
});

test('enrichment runs on the queue, never in the CallScaler webhook', async () => {
  // CallScaler retries a slow delivery, and a retried webhook is how one
  // submission became several contacts.
  const route = await readFile(
    new URL('../app/api/webhooks/callscaler/route.ts', import.meta.url),
    'utf8'
  );
  const callscaler = await readFile(
    new URL('../lib/integrations/callscaler.ts', import.meta.url),
    'utf8'
  );
  const migration = await readFile(
    new URL('../supabase/migrations/0024_comprehensive_hardening.sql', import.meta.url),
    'utf8'
  );
  assert.match(callscaler, /\.rpc\('complete_call_processing'/);
  assert.match(migration, /complete_call_processing[\s\S]*?'contact_enrichment'/);
  assert.doesNotMatch(route, /lookupPhoneIdentity|enrichContactFromPhone/);
});

test('every job kind in the TypeScript union is allowed by the database', async () => {
  // deep_search shipped in the union without the constraint and every enqueue
  // failed with 23514 — no row, no log, and a 500 that read as a hang. This
  // fails the build instead of production.
  const queue = await readFile(new URL('../lib/job-queue.ts', import.meta.url), 'utf8');
  const union = queue.slice(queue.indexOf('export type JobKind'), queue.indexOf(';', queue.indexOf('export type JobKind')));
  const kinds = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(kinds.length >= 6, 'found the union members');

  // The newest constraint definition wins, so scan every migration in order.
  const { readdir } = await import('node:fs/promises');
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  let allowed = null;
  for (const f of files) {
    const sql = await readFile(new URL(f, dir), 'utf8');
    for (const m of sql.matchAll(/job_queue_kind_check check \(\s*kind in \(([^)]*)\)/g)) {
      allowed = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    }
  }
  assert.ok(allowed, 'found a kind constraint in the migrations');
  const missing = kinds.filter((k) => !allowed.includes(k));
  assert.deepEqual(missing, [], `kinds the database would reject: ${missing.join(', ')}`);
});

test('clearing one fact field leaves the others intact', async () => {
  // Facts are not interchangeable. A wrong county should go without taking a
  // correct middle name and booking date with it — which the old all-or-nothing
  // reset could not do.
  const { clearLearnedFact } = await import('../lib/deep-search/confirmed.ts');
  const before = {
    county: ['Durham'],
    middle: ['Michael'],
    booking_dates: ['2026-04-22'],
    state: ['NC'],
  };
  const after = clearLearnedFact(before, 'county');
  assert.deepEqual(after.county, []);
  assert.deepEqual(after.middle, ['Michael'], 'middle survives');
  assert.deepEqual(after.booking_dates, ['2026-04-22'], 'booking date survives');
  assert.deepEqual(after.state, ['NC'], 'state survives');
});

test('clearing a fact field does not touch confirmed values', async () => {
  // Discarding a machine guess and retracting something a human vouched for are
  // different intentions; they must not share a control.
  const route = await readFile(
    new URL('../app/api/contacts/[id]/candidates/route.ts', import.meta.url),
    'utf8'
  );
  const at = route.indexOf("action === 'clear_fact'");
  assert.ok(at > -1, 'the clear_fact branch exists');
  const branch = route.slice(at, at + 1200);
  assert.match(branch, /select\('search_facts'\)/, 'reads only the learned store');
  assert.match(branch, /update\(\{ search_facts: next \}\)/, 'writes only the learned store');
  assert.doesNotMatch(branch, /confirmed_facts/, 'confirmed values are untouched');
  assert.match(branch, /requireAdmin\(\)/);
});

test('clearing links no longer wipes the facts', async () => {
  // The button is scoped to links now; facts have their own per-field controls.
  const route = await readFile(
    new URL('../app/api/contacts/[id]/candidates/route.ts', import.meta.url),
    'utf8'
  );
  const del = route.slice(route.indexOf('export async function DELETE'), route.indexOf('export async function PATCH'));
  assert.doesNotMatch(del, /search_facts: \{\}/, 'DELETE must not reset facts');
  // The parts that still have to go, or a re-run would rebuild the same set.
  assert.match(del, /\.in\('status', \['new', 'rejected'\]\)/);
  assert.match(del, /\.eq\('kind', 'deep_search'\)/);
});

test('the status filter is a single dropdown, not a chip per status', async () => {
  // Sixteen statuses wrapped over multiple lines and pushed the grid below the
  // fold. The colour dot stays, because that cue is shared with the rows.
  const page = await readFile(new URL('../app/(app)/contacts/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /aria-label="Filter by status"/);
  assert.match(page, /<option value="">Any<\/option>/);
  assert.match(page, /statuses\.map\(\(s\) => \(\s*<option/);
  // The old row of buttons is gone.
  assert.doesNotMatch(page, /onClick=\{\(\) => setStatusFilter\(statusFilter === s\.id \? '' : s\.id\)\}/);
});

test('the toolbar is tightened: short labels, no owner view, green New button', async () => {
  const page = await readFile(new URL('../app/(app)/contacts/page.tsx', import.meta.url), 'utf8');
  // Contacts aren't assigned to owners at this time, so the view chip is gone
  // (the ViewId type keeps 'mine' because the counts RPC still returns it).
  assert.doesNotMatch(page, /label: 'My contacts'/);
  // The flag view is icon-only and 'New this week' is just 'New'; the title
  // attribute carries what the longer labels used to say.
  assert.match(page, /label: '⚑', title:/);
  assert.match(page, /label: 'New', title:/);
  assert.doesNotMatch(page, /New this week/);
  // The primary button is a translucent green pill labelled New — red was the
  // one saturated fill on the page and read as a warning, not an invitation.
  assert.match(page, /bg-green-600\/15/);
  assert.doesNotMatch(page, /bg-red-600/);
});

test('a known county can be entered by hand and lands in the confirmed store', async () => {
  // Seeding matters most BEFORE the first run: a common name plus a known
  // county is the difference between one match and five (the Gabriel Lopez
  // problem). Both entry points must write confirmed_facts — the store that
  // seeds every run — not the learned search_facts a clear would wipe.
  const page = await readFile(new URL('../app/(app)/contacts/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /confirmed_facts: \{ county: \[county\] \}/, 'new-contact modal seeds county');
  const panel = await readFile(new URL('../components/ContactPanel.tsx', import.meta.url), 'utf8');
  assert.match(
    panel,
    /action: 'confirm_fact', key: 'county', value: county/,
    'panel adds a county through the same confirm_fact action the ✓ uses'
  );
});
