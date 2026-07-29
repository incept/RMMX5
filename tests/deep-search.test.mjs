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
  isNonRecordUrl,
  normalizeLlmRow,
} from '../lib/deep-search/extract.ts';
import { isAmbiguous, profilesFor } from '../lib/deep-search/profiles.ts';

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

test('the default window is a rolling seven years ending today', () => {
  // Every ordinary run gets this window, computed fresh each run. Learned
  // booking dates deliberately do not narrow it: a window bracketing known
  // dates excluded a brand-new July 23 record from the very site search that
  // had it, and an eight-year-old arrest is the only thing seven years cuts.
  const w = dateWindow([], new Date('2026-07-27T00:00:00Z'));
  assert.equal(w.from, '2019-07-27');
  assert.equal(w.to, '2026-07-27');
});

test('a focused window hugs its one arrest', () => {
  // Passing dates means a run branched into ONE booking; padded a week either
  // side because sites disagree on arrest vs booking vs publish date.
  const today = new Date('2026-07-27T12:00:00Z');
  const w = dateWindow(['2026-04-22'], today);
  assert.equal(w.from, '2026-04-15');
  assert.equal(w.to, '2026-04-29');
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
  // arre.st (19 links) consume…13398 tokens truncated…words next to the row.
  assert.match(panel, /arrests on record/);
  // The plain button must not leak its click event into the focus parameter.
  assert.match(panel, /onClick=\{\(\) => runDeepSearch\(\)\}/);
  assert.doesNotMatch(panel, /onClick=\{runDeepSearch\}/);
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

/* ── The deadline concludes a run; a human deletion sticks ─────────────────── */

test('the deadline concludes a run instead of destroying it', async () => {
  const engine = await readFile(new URL('../lib/deep-search/index.ts', import.meta.url), 'utf8');
  // The old tripwire threw at the deadline: candidates unflushed, facts
  // unpersisted, and the job retried into the same wall.
  assert.doesNotMatch(engine, /ensureTime/);
  assert.doesNotMatch(engine, /throw new Error\('Deep search reached its execution deadline'\)/);
  // Every phase loop breaks on the clock instead.
  const checks = engine.match(/outOfTime\(\)/g) ?? [];
  assert.ok(checks.length >= 7, `phase loops check the clock; saw ${checks.length}`);
  // Expensive phases skip work they cannot finish rather than starting it:
  // mining needs a wide margin, and a SERP fallback needs its own timeout.
  assert.match(engine, /msLeft\(\) < 60_000/);
  assert.match(engine, /msLeft\(\) < FALLBACK_TIMEOUT_MS \+ 5_000/);
  // A mid-fetch abort is contained at the call site, in both fetch loops.
  const contained =
    engine.match(/outcome = \{ ok: false, reason: errorMessage\(e\), blocked: false \}/g) ?? [];
  assert.equal(contained.length, 2, 'both fetchProbePage call sites are wrapped');
  // And the operator is told plainly that the window closed early.
  assert.match(engine, /partial results; re-run to continue/);
});

test('one slow LLM extraction cannot eat half the run window', async () => {
  const llm = await readFile(new URL('../lib/deep-search/llm.ts', import.meta.url), 'utf8');
  assert.match(llm, /EXTRACT_TIMEOUT_MS = 20_000/);
  // The extraction path no longer carries the old 45s cap anywhere.
  const extractPart = llm.slice(0, llm.indexOf('classifySerpResults'));
  assert.doesNotMatch(extractPart, /45_000/);
});

test('a link a human removed stays removed', async () => {
  // Auto search's only dedupe was against URLs currently IN slots, so deleting
  // a link just made room for the next run to re-place the same page.
  const route = await readFile(
    new URL('../app/api/contacts/[id]/links/route.ts', import.meta.url),
    'utf8'
  );
  // Both removal shapes are remembered: clearing a slot and replacing its URL.
  assert.match(route, /removedUrls\.push\(prev\.url\)/);
  assert.match(route, /removedUrls\.map\(\(url\) => rememberRemoval\(admin, id, url\)\)/);
  assert.match(route, /status: 'rejected'/);
  // And the auto search consults that memory before placing a link.
  const intake = await readFile(new URL('../lib/lead-intake.ts', import.meta.url), 'utf8');
  assert.match(intake, /\.eq\('status', 'rejected'\)/);
  assert.match(intake, /humanRejected\.has\(canonical\)/);
});

/* ── Search-state icon, dashboard stages, status management, county field ──── */

test('the grid shows deep-search state and can start a run from it', async () => {
  const page = await readFile(new URL('../app/(app)/contacts/page.tsx', import.meta.url), 'utf8');
  // Three states from two stamps: amber while queued, green when done, red
  // when never run. Amber is a state, not a button — and it expires after 30
  // minutes rather than hiding a dead run forever.
  assert.match(page, /const running = queuedAge < 30 \* 60_000/);
  assert.match(page, /text-amber-500/);
  assert.match(page, /text-red-500/);
  assert.match(page, /queueDeepSearch\(contact\)/);
  assert.match(page, /!isAdmin \|\| running/);
  // The migration feeds both stamps through the grid RPC.
  const migration = await readFile(
    new URL('../supabase/migrations/0025_deep_search_state.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration, /add column if not exists deep_searched_at timestamptz/);
  assert.match(migration, /c\.deep_searched_at, c\.deep_search_queued_at/);
  // Atomic enqueue stamps amber; the run's conclusion stamps green and clears
  // it after the last queued sibling.
  const route = await readFile(
    new URL('../app/api/contacts/[id]/deep-search/route.ts', import.meta.url),
    'utf8'
  );
  assert.match(route, /enqueueDeepSearchJob/);
  const engine = await readFile(new URL('../lib/deep-search/index.ts', import.meta.url), 'utf8');
  const hardening = await readFile(
    new URL('../supabase/migrations/0028_deep_search_attempt_state.sql', import.meta.url),
    'utf8'
  );
  assert.match(engine, /finish_deep_search_attempt/);
  assert.match(hardening, /deep_searched_at = now\(\)/);
  assert.match(hardening, /when v_next_job_id is null then null/);
});

test('focused deep-search siblings serialize and exact attempts finalize atomically', async () => {
  const queue = await readFile(new URL('../lib/job-queue.ts', import.meta.url), 'utf8');
  const route = await readFile(
    new URL('../app/api/contacts/[id]/deep-search/route.ts', import.meta.url),
    'utf8'
  );
  const engine = await readFile(new URL('../lib/deep-search/index.ts', import.meta.url), 'utf8');
  const migration = await readFile(
    new URL('../supabase/migrations/0028_deep_search_attempt_state.sql', import.meta.url),
    'utf8'
  );

  assert.match(migration, /create or replace function public\.enqueue_deep_search_job/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /job_queue_active_deep_search_contact_idx/);
  assert.match(migration, /deep_search_job_id = v_pointer_id/);
  assert.match(route, /enqueueDeepSearchJob/);
  assert.doesNotMatch(route, /\.from\('contacts'\)\s*\.update/);

  const claim = migration.slice(migration.indexOf('create or replace function public.claim_jobs'));
  assert.match(claim, /sibling\.payload ->> 'contactId'/);
  assert.match(claim, /order by sibling\.created_at, sibling\.id/);
  assert.match(claim, /for update of j skip locked/);

  const finish = migration.slice(
    migration.indexOf('create or replace function public.finish_deep_search_attempt'),
    migration.indexOf('create or replace function public.fail_deep_search_attempt')
  );
  assert.match(finish, /j\.locked_by = p_worker/);
  assert.match(finish, /j\.attempt_count = p_attempt_count/);
  assert.match(finish, /status = 'completed'/);
  assert.match(finish, /deep_search_job_id = v_next_job_id/);
  assert.match(finish, /deep_search_flag_job_id/);
  assert.match(finish, /else c\.search_flag/, 'unrelated/manual flags are preserved');
  assert.match(migration, /drop function if exists public\.finish_deep_search_state/);

  assert.match(engine, /p_worker: opts\.jobWorker!/);
  assert.match(engine, /p_attempt_count: opts\.jobAttempt!/);
  assert.match(queue, /if \(job\.kind !== 'deep_search'\) await completeJob/);
  assert.match(queue, /finalizedThisAttempt/);
  assert.match(queue, /current\?\.status === 'completed'/);
  assert.match(queue, /\.eq\('attempt_count', job\.attempt_count\)/);
  assert.match(queue, /job payload is missing a valid \$\{key\}/);
});

test('deep-search retry generations, malformed failure, and lock order stay safe', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/0028_deep_search_attempt_state.sql', import.meta.url),
    'utf8'
  );
  const enqueue = migration.slice(
    migration.indexOf('create or replace function public.enqueue_deep_search_job'),
    migration.indexOf('create or replace function public.finish_deep_search_attempt')
  );
  const failedBranch = enqueue.slice(enqueue.indexOf("if v_status = 'failed' then"));
  const retiredAt = failedBranch.indexOf(
    "dedupe_key = p_dedupe_key || ':retired:' || v_job_id::text"
  );
  const freshInsertAt = failedBranch.indexOf('insert into public.job_queue', retiredAt);
  assert.ok(retiredAt >= 0 && freshInsertAt > retiredAt, 'a retry archives then inserts a new id');
  assert.doesNotMatch(
    failedBranch.slice(0, failedBranch.indexOf('else')),
    /attempt_count = 0/,
    'a retry never reuses attempt-number-based provider keys'
  );
  assert.match(enqueue, /lower\(j\.payload ->> 'contactId'\) = p_contact_id::text/);
  assert.match(
    enqueue,
    /when c\.deep_search_job_id is distinct from v_pointer_id then now\(\)/
  );

  const finish = migration.slice(
    migration.indexOf('create or replace function public.finish_deep_search_attempt'),
    migration.indexOf('create or replace function public.fail_deep_search_attempt')
  );
  const finishAdvisory = finish.indexOf('pg_advisory_xact_lock');
  const finishContactLock = finish.indexOf('from public.contacts c', finishAdvisory);
  const finishJobLock = finish.indexOf('select j.payload', finishContactLock);
  assert.ok(
    finishAdvisory < finishContactLock && finishContactLock < finishJobLock,
    'completion locks advisory, contact, then job'
  );
  assert.match(finish, /lower\(v_payload ->> 'contactId'\)/);
  assert.match(finish, /when v_next_job_id is null then null\s+else now\(\)/);

  const fail = migration.slice(
    migration.indexOf('create or replace function public.fail_deep_search_attempt'),
    migration.indexOf('create or replace function public.cancel_jobs_for_deleted_contact')
  );
  assert.match(fail, /c\.deep_search_job_id = p_job_id/);
  assert.match(fail, /if v_contact_id is not null then/);
  assert.ok(
    fail.indexOf("status = 'failed'") < fail.lastIndexOf('if v_contact_id is not null then'),
    'an orphaned malformed job is failed before optional contact cleanup'
  );
  const failAdvisory = fail.indexOf('pg_advisory_xact_lock');
  const failContactLock = fail.indexOf('from public.contacts c', failAdvisory);
  const failJobLock = fail.indexOf('select j.payload', failContactLock);
  assert.ok(
    failAdvisory < failContactLock && failContactLock < failJobLock,
    'terminal failure locks advisory, contact, then job when a contact exists'
  );

  const deletion = migration.slice(
    migration.indexOf('create or replace function public.cancel_jobs_for_deleted_contact'),
    migration.indexOf('drop function if exists public.finish_deep_search_state')
  );
  assert.doesNotMatch(deletion, /for update/);
  assert.equal(
    (deletion.match(/j\.status = 'processing'/g) ?? []).length,
    2,
    'deletion checks processing work before and after cancelling pending rows'
  );

  const claim = migration.slice(migration.indexOf('create or replace function public.claim_jobs'));
  assert.match(claim, /c\.deep_search_job_id = j\.id/);
  assert.match(claim, /lower\(sibling\.payload ->> 'contactId'\) = v_contact_key/);
  assert.match(claim, /coalesce\(lower\(sibling\.payload ->> 'contactId'\)/);
});

test('deleting a status moves its contacts where the admin chose', async () => {
  const route = await readFile(
    new URL('../app/api/admin/statuses/[id]/route.ts', import.meta.url),
    'utf8'
  );
  assert.match(route, /requireAdmin\(\)/);
  // The FK is ON DELETE SET NULL — without the guard, deletion silently
  // strips the status off every contact in it.
  assert.match(route, /pick a status to move them to first/);
  assert.match(route, /update\(\{ status_id: moveTo \}\)/);
  assert.ok(
    route.indexOf('status_id: moveTo') < route.indexOf(".delete()"),
    'contacts move BEFORE the status is deleted'
  );
});

test('status edits fail loudly instead of silently vanishing', async () => {
  const page = await readFile(
    new URL('../app/(app)/admin/pipeline/page.tsx', import.meta.url),
    'utf8'
  );
  // Zero-rows-affected (a silent RLS denial) and unique-name violations both
  // get a readable message — this is how a new status "could not be named".
  assert.match(page, /!data\?\.length/);
  assert.match(page, /23505/);
  // Enter commits, and Add picks a unique default name instead of silently
  // colliding with the unique constraint.
  assert.match(page, /e\.key === 'Enter' && e\.currentTarget\.blur\(\)/);
  assert.match(page, /for \(let n = 2; taken\.has\(name\); n \+= 1\)/);
});

test('the dashboard leads with the stages that need a hand', async () => {
  const page = await readFile(new URL('../app/(app)/dashboard/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /'New', 'No Link', 'Pending Service', 'Pending Confirmation'/);
  assert.doesNotMatch(page, /Avg Reputation Score/);
  assert.doesNotMatch(page, /Links removed/);
  assert.doesNotMatch(page, /Live links/);
  // The contacts box is a link into the grid.
  assert.match(page, /href: '\/contacts'/);
});

test('county is editable from the Contact Info tab', async () => {
  const panel = await readFile(new URL('../components/ContactPanel.tsx', import.meta.url), 'utf8');
  const at = panel.indexOf("tab === 'Contact Info'");
  assert.ok(at > -1);
  const block = panel.slice(at, at + 7000);
  // Same confirmed store and the same chips as the search tab — a county
  // typed on either tab seeds every run.
  assert.match(block, /confirmed_facts\?\.county/);
  assert.match(block, /confirmCounty\(\)/);
});

/* ── Non-record URLs are never findings; the last run is visible ───────────── */

test('search pages, sitemaps, and feeds are never findings', () => {
  // The exact noise the operator reported: a site search carrying the full
  // name (scores 0.55 on the name alone), and a sitemap XML from a SERP.
  assert.equal(isNonRecordUrl('https://bustednewspaper.com/search/perriaye+powe/#'), true);
  assert.equal(
    isNonRecordUrl('https://bustednewspaper.com/posts-sitemap/posts-sitemap-links-17.xml'),
    true
  );
  assert.equal(isNonRecordUrl('https://leefl.mugshots.zone/?s=LOPEZ+GABRIEL'), true);
  assert.equal(isNonRecordUrl('https://example.com/feed/'), true);
  assert.equal(isNonRecordUrl('not a url'), true);
  // Real record pages sail through — including ones with non-search params.
  assert.equal(
    isNonRecordUrl('https://recentlybooked.com/ga/catoosa/perriaye-powe~1330_ppafb07232026'),
    false
  );
  assert.equal(isNonRecordUrl('https://florida.arrests.org/Arrests/Gabriel_Lopez_63297364/'), false);
  assert.equal(isNonRecordUrl('https://wakencbusts.com/view-full-profile.php?id=140252'), false);
});

test('every intake point drops non-record URLs, and unseen leads are not hits', async () => {
  const engine = await readFile(new URL('../lib/deep-search/index.ts', import.meta.url), 'utf8');
  const drops = engine.match(/isNonRecordUrl\(/g) ?? [];
  assert.ok(
    drops.length >= 4,
    `probe rows, mined rows, SERP fallback, and unruled capture all filter; saw ${drops.length}`
  );
  // Derived pages and id pivots no longer mark a domain as having evidence, so
  // the "every arrest" search link only appears for a site where a real record
  // was actually seen — whose search page is not blank by definition.
  const derivedAt = engine.indexOf('Date-addressed pages, derived rather than searched');
  const siteSearchAt = engine.indexOf('One "all arrests on this site" link per site');
  assert.ok(derivedAt > -1 && siteSearchAt > -1);
  assert.doesNotMatch(engine.slice(derivedAt, siteSearchAt), /sitesWithHits\.add/);
  // The auto search cannot put a search page or sitemap into a link slot.
  const intake = await readFile(new URL('../lib/lead-intake.ts', import.meta.url), 'utf8');
  assert.match(intake, /isNonRecordUrl\(result\.link\)/);
});

test('the panel shows when the last deep search ran', async () => {
  const panel = await readFile(new URL('../components/ContactPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /Last run \$\{new Date\(contact\.deep_searched_at\)\.toLocaleString\(\)\}/);
  assert.match(panel, /Deep search queued…/);
});

test('deep-search controls distinguish completed duplicates and monitor background outcomes', async () => {
  const panel = await readFile(new URL('../components/ContactPanel.tsx', import.meta.url), 'utf8');
  const grid = await readFile(new URL('../app/(app)/contacts/page.tsx', import.meta.url), 'utf8');

  // A completed idempotency hit is not presented as a queued job.
  assert.match(panel, /data\.status === 'already completed this hour'/);
  assert.match(grid, /data\.status === 'already completed this hour'/);
  // Both entry points poll slowly and stop after a fixed bound. They read the
  // authoritative contact stamps so terminal worker failures become visible.
  for (const source of [panel, grid]) {
    assert.match(source, /DEEP_SEARCH_POLL_INTERVAL_MS = 30_000/);
    assert.match(source, /document\.visibilityState !== 'visible'/);
    assert.match(source, /deep_search_queued_at, deep_searched_at, search_flag/);
    assert.match(source, /Admin → Debug Log/);
  }
  assert.match(panel, /DEEP_SEARCH_POLL_LIMIT = 40/);
  // The grid has one timer/query for every watched contact, not one permanent
  // polling loop per click.
  assert.match(grid, /DEEP_SEARCH_POLL_WINDOW_MS = 20 \* 60_000/);
  assert.match(grid, /\.in\('id', ids\)/);
  assert.match(grid, /deepSearchPollTimer/);
  assert.doesNotMatch(grid, /Symbol\(`deep-search-\$\{contact\.id\}`\)/);
});

test('contact grid recovers from rejected loads and deep-search enqueue requests', async () => {
  const grid = await readFile(new URL('../app/(app)/contacts/page.tsx', import.meta.url), 'utf8');
  assert.match(grid, /catch \(error\) \{[\s\S]*?setLoadError/);
  assert.match(grid, /finally \{\s*setLoading\(false\)/);
  assert.match(grid, /const previousQueuedAt = contact\.deep_search_queued_at/);
  assert.match(grid, /deep_search_queued_at: previousQueuedAt/);
  assert.match(grid, /rollbackOptimisticStamp\(\);\s*flash\(data\.error/);
  assert.match(grid, /Could not queue the deep search:/);
});

test('Admin Debug shows read failures instead of claiming the log is empty', async () => {
  const debug = await readFile(
    new URL('../app/(app)/admin/debug/page.tsx', import.meta.url),
    'utf8'
  );
  assert.match(debug, /const \[loadError, setLoadError\]/);
  assert.match(debug, /const \{ data, error \} = await query/);
  assert.match(debug, /if \(error\) throw error/);
  assert.match(debug, /Could not load the Admin Debug Log/);
  assert.match(debug, /!loading && !loadError && entries\.length === 0/);
});

test('runtime setup documents the current migration and Node requirements', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /highest-numbered migration shipped/);
  assert.match(readme, /0028_deep_search_attempt_state\.sql/);
  assert.match(readme, /22\.19\.0 or newer/);
});
