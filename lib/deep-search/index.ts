import { createAdminClient } from '@/lib/supabase/server';
import {
  canonicalUrl,
  mergeSerpResults,
  runSerpSearch,
  type SearchEngine,
  type SerpResult,
} from '@/lib/integrations/brightdata';
import { matchUrlRule, type UrlRule } from '@/lib/scoring';
import { logActivity } from '@/lib/activity';
import { logDebug, errorMessage } from '@/lib/debug-log';
import {
  type NameParts,
  type SearchFacts,
  EMPTY_FACTS,
  countySlug,
  dateWindow,
  factsAreEqual,
  mergeFacts,
  normalizeFacts,
  scoreCorroboration,
  splitName,
  stateCode,
  stateName,
} from './facts.ts';
import { fetchProbePage, linksFromText, logProbeFailure, stripToText } from './fetch-page.ts';
import { factsFromLlmRows, factsFromText, factsFromUrl, isNonRecordUrl } from './extract.ts';
import { classifySerpResults, extractRowsWithLlm } from './llm.ts';

/**
 * Deep search, phase 1: probe-first discovery.
 *
 * Round A probes national sites, plus state-scoped sites matching the lead's
 * state (IP geolocation already gave us that). Those hits normally yield the
 * middle name and the county. Round B then probes county-scoped sites and
 * county subdomains that only became addressable once the county was known —
 * the chaining that was previously done by hand, at zero SERP cost.
 *
 * Everything found lands in search_candidates for review rather than filling
 * link slots directly: the matching logic has to earn trust first, and every
 * row carries the domain and round that produced it so that is auditable.
 */

const MAX_PROBES_PER_RUN = 24; // ~24 page fetches worst case, at 3–15 leads/day
const PER_DOMAIN_DELAY_MS = 400; // politeness; negligible at this volume
// A metro area can straddle several counties — Atlanta covers Fulton, DeKalb,
// and Cobb — so a lead legitimately carries more than two. The date-addressed
// roster phase builds one URL per (site × date × county); this caps the county
// fan-out there so the combination stays bounded while still covering a
// multi-county city. Direct county probing (round 1) already uses them all.
const MAX_DERIVED_COUNTIES = 4;
/** Surname plus at least one more agreeing signal. Surname alone scores 0.4. */
const MIN_CONFIDENCE = 0.55;
/** site: queries cost a SERP request each, so the per-run count is bounded. */
const MAX_SERP_FALLBACKS = 4;
/**
 * A fallback query is one of up to eight in a run, so it gets a tighter deadline
 * than a name search. Bing was timing out at 60s on site: queries and adding
 * that wait to every domain. Raised from 25s: a fifth of fallbacks were dying at
 * the cap on slow-but-valid responses. (A persistently timing-out SERP points at
 * the BrightData zone config, which a client-side timeout cannot fix.)
 */
const FALLBACK_TIMEOUT_MS = 30_000;
/**
 * One broad, un-site-restricted name search per run — the highest-value SERP
 * spend, since it finds records on sites we can't probe (a county-scoped site
 * with no county) or that aren't in the registry at all. It gets a name-search
 * deadline, not the tighter fallback one.
 */
const BROAD_QUERY_TIMEOUT_MS = 40_000;
const MAX_BROAD_QUERY_RESULTS = 20;
const CANDIDATE_BATCH_SIZE = 25;

type CandidateAttempt = { jobId: string; worker: string; attempt: number };

class CandidateWriter {
  private rows: Record<string, any>[] = [];

  constructor(
    private readonly supabase: ReturnType<typeof createAdminClient>,
    private readonly attempt?: CandidateAttempt
  ) {}

  async add(row: Record<string, any>) {
    this.rows.push(row);
    if (this.rows.length >= CANDIDATE_BATCH_SIZE) await this.flush();
  }

  async flush() {
    if (!this.rows.length) return;
    const batch = this.rows.splice(0, this.rows.length);
    if (this.attempt) {
      const { data, error } = await this.supabase.rpc('write_deep_search_candidates', {
        p_job_id: this.attempt.jobId,
        p_worker: this.attempt.worker,
        p_attempt_count: this.attempt.attempt,
        p_rows: batch,
      });
      if (error) throw new Error(`Could not store candidate batch: ${error.message}`);
      if (Number(data) < 0) throw new Error('Deep-search attempt lost its lease before writing candidates');
      return;
    }
    const { error } = await this.supabase
      .from('search_candidates')
      .upsert(batch, { onConflict: 'contact_id,canonical_url', ignoreDuplicates: true });
    if (error) throw new Error(`Could not store candidate batch: ${error.message}`);
  }
}

interface ProbeSite {
  id: string;
  domain: string;
  name: string | null;
  search_template: string;
  scope: 'national' | 'state' | 'county';
  scope_state: string | null;
  scope_county: string | null;
  family: string | null;
  active: boolean;
  serp_fallback: boolean;
  record_url_template: string | null;
  needs_render: boolean;
  needs_browser: boolean;
  priority: number;
  date_url_template: string | null;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Builds a date-addressed page URL, e.g. the daily county roster at
 * northcarolina.arrests.org/Wake/2026/April/22/.
 *
 * Worth having because it needs no request at all: on a host BrightData refuses
 * to fetch, whose name searches can miss a page addressed by date rather than by
 * person, the county and booking date we already hold name the exact URL.
 */
function buildDateUrl(
  template: string,
  isoDate: string,
  county: string | null,
  state: string | null
): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const [, yyyy, mm, dd] = m;
  const monthName = MONTH_NAMES[Number(mm) - 1];
  if (!monthName) return null;

  const values: Record<string, string | null> = {
    yyyy,
    mm,
    // Unpadded: the observed URLs use /April/22/. If single-digit days 404, this
    // is the one place to change.
    dd: String(Number(dd)),
    month_name: monthName,
    county: county ? encodeURIComponent(county.replace(/\s*county\s*/i, '').trim()) : null,
    county_slug: county ? countySlug(county) : null,
    state: state ?? null,
    state_name: state ? stateName(state) : null,
  };

  let out = template;
  for (const match of template.matchAll(/[{](\w+)[}]/g)) {
    const value = values[match[1]];
    if (value == null || value === '') return null;
    out = out.replaceAll('{' + match[1] + '}', value);
  }
  return out;
}

/** Records which record ids came from which operator network. */
function rememberFamilyIds(
  store: Map<string, Set<string>>,
  family: string | null,
  ids: string[]
) {
  if (!family || !ids.length) return;
  const set = store.get(family) ?? new Set();
  for (const id of ids) set.add(id);
  store.set(family, set);
}

/** Fills a record_url_template. Returns null if a placeholder is unknown. */
function buildRecordUrl(
  template: string,
  recordId: string,
  county: string | null
): string | null {
  const values: Record<string, string | null> = {
    record_id: encodeURIComponent(recordId),
    county_slug: county ? countySlug(county) : null,
  };
  let out = template;
  for (const m of template.matchAll(/[{](\w+)[}]/g)) {
    const value = values[m[1]];
    if (value == null || value === '') return null;
    out = out.replaceAll('{' + m[1] + '}', value);
  }
  return out;
}

/** True when a URL lives on the site's domain, including its subdomains. */
function urlOnDomain(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    const d = domain.toLowerCase().replace(/^www\./, '');
    return host === d || host.endsWith('.' + d);
  } catch {
    return false;
  }
}

export interface DeepSearchResult {
  probed: number;
  blocked: number;
  candidates: number;
  facts: SearchFacts;
  rounds: number;
  serpFallbacks: number;
  pivots: number;
  derived: number;
  siteSearches: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fills a search_template. Returns null when a needed placeholder is unknown. */
function buildProbeUrl(
  template: string,
  name: NameParts,
  county: string | null,
  state: string | null,
  window: { from: string; to: string }
): string | null {
  const plus = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
  const values: Record<string, string | null> = {
    name: plus([name.first, name.last].filter(Boolean).join(' ')),
    first: plus(name.first),
    last: plus(name.last),
    middle: name.middle ? plus(name.middle) : null,
    county: county ? plus(county) : null,
    county_slug: county ? countySlug(county) : null,
    state: state ?? null,
    state_lower: state ? state.toLowerCase() : null,
    state_name: state ? stateName(state) : null,
    // Always fillable: dateWindow falls back to a wide range, so a site that
    // requires FromDate/ToDate is never skipped for want of a booking date.
    from_date: window.from,
    to_date: window.to,
  };

  let out = template;
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    const key = m[1];
    const value = values[key];
    if (value == null || value === '') return null; // unsatisfiable this round
    out = out.replaceAll(`{${key}}`, value);
  }
  return out;
}

/** Candidate rows a probe page yielded, before scoring. */
interface RawRow {
  url: string;
  text: string;
}

/**
 * Rows from one probe page. Prefers the LLM's reading of the layout; falls back
 * to same-domain links whose text mentions the surname, which is enough for the
 * common "list of matching records" page.
 */
async function rowsFromPage(
  pageText: string,
  pageUrl: string,
  domain: string,
  name: NameParts,
  contactId: string,
  opts?: { signal?: AbortSignal; requestKey?: string }
): Promise<{ rows: RawRow[]; llmFacts: SearchFacts | null }> {
  const llmRows = await extractRowsWithLlm(pageText, name, contactId, opts);
  if (llmRows && llmRows.length) {
    const rows = llmRows
      .filter((r) => r.url && /^https?:\/\//i.test(r.url))
      .map((r) => ({
        url: r.url!,
        // Flattened rather than .join()ed on charges: normalizeLlmRow now
        // guarantees an array, but this stays shape-agnostic so a future caller
        // handing over raw model output cannot crash the run again.
        text: [r.name, r.middle, r.county, r.state, r.booking_date]
          .concat(Array.isArray(r.charges) ? r.charges : [r.charges as any])
          .filter(Boolean)
          .join(' '),
      }));
    return { rows, llmFacts: factsFromLlmRows(llmRows) };
  }

  const last = name.last.toLowerCase();
  const rows = linksFromText(pageText)
    .filter((l) => {
      if (!l.url.toLowerCase().includes(domain.replace(/^www\./, ''))) return false;
      return l.text.toLowerCase().includes(last) || l.url.toLowerCase().includes(last);
    })
    .slice(0, 25)
    .map((l) => ({ url: l.url, text: l.text }));
  return { rows, llmFacts: null };
}

export async function runDeepSearchForContact(
  contactId: string,
  actorId?: string | null,
  opts?: {
    deadlineMs?: number;
    requestKey?: string;
    signal?: AbortSignal;
    focusDate?: string;
    jobId?: string;
    jobWorker?: string;
    jobAttempt?: number;
    // Force a full sweep: re-probe even sites that already hold a confirmed
    // record for this contact. Default (false) skips those on a re-run to save
    // the fetch and any billable fallback — a confirmed record won't change.
    fullReprobe?: boolean;
  }
): Promise<DeepSearchResult> {
  const supabase = createAdminClient();
  if (
    opts?.jobId &&
    (!opts.jobWorker || !Number.isInteger(opts.jobAttempt) || Number(opts.jobAttempt) < 1)
  ) {
    throw new Error('Deep-search queue attempt identity is incomplete');
  }
  // A focused run branches out ONE arrest of a multi-arrest person: that date
  // is pinned and every date-built URL and search window uses it alone, so the
  // run digs into this booking instead of re-treading all of them.
  const focusDate = /^\d{4}-\d{2}-\d{2}$/.test(String(opts?.focusDate ?? ''))
    ? (opts!.focusDate as string)
    : null;
  const budgetMs = Math.min(Math.max(opts?.deadlineMs ?? 95_000, 10_000), 110_000);
  const deadlineSignal = AbortSignal.timeout(budgetMs);
  const signal = opts?.signal ? AbortSignal.any([deadlineSignal, opts.signal]) : deadlineSignal;
  // Time is a budget, not a tripwire. The old guard THREW at the deadline,
  // which destroyed the run — candidates unflushed, facts unpersisted, and the
  // job retried into the same wall, so a minute of paid fetches bought nothing.
  // Now every phase loop breaks on outOfTime() and the run CONCLUDES with what
  // it found, and msLeft() lets expensive phases skip work they cannot finish.
  const startedAt = Date.now();
  const msLeft = () => budgetMs - (Date.now() - startedAt);
  let deadlineHit = false;
  const outOfTime = () => {
    if (!deadlineHit && signal.aborted) deadlineHit = true;
    return deadlineHit;
  };

  const { data: contact, error: contactError } = await supabase
    .from('contacts')
    .select('id, name, city, state, search_facts, confirmed_facts')
    .eq('id', contactId)
    .single();
  if (contactError) throw new Error(`Could not load contact for deep search: ${contactError.message}`);
  if (!contact?.name) throw new Error('Contact has no name to search for');

  const name = splitName(contact.name);
  if (!name.last) throw new Error(`"${contact.name}" has no surname to corroborate matches against`);

  // Facts a human has confirmed, which outrank anything a page told us.
  //
  // Three sources, in descending authority: explicitly confirmed facts, the link
  // slots, and the contact record. A URL only reaches a slot when somebody
  // accepted it, so every slot link is a verified sighting of this person — and
  // parsing one costs nothing while often supplying the county and booking date
  // that round B would otherwise have to discover by probing.
  //
  // Order matters beyond neatness. Probe URLs are built from facts.county[0] and
  // facts.state[0], and each key is capped, so merging confirmed FIRST is what
  // makes the confirmed value the one actually searched rather than merely
  // present. confirmed_facts leads because it is the strongest signal there is:
  // a human said so, and it survives Clear results when search_facts does not.
  const { data: slotLinks, error: slotLinksError } = await supabase
    .from('contact_links')
    .select('url')
    .eq('contact_id', contactId);
  if (slotLinksError) {
    throw new Error(`Could not load confirmed contact links: ${slotLinksError.message}`);
  }

  let pinned: SearchFacts = { ...EMPTY_FACTS };
  // Merged first so a focused run's date takes the front of the variant list.
  if (focusDate) pinned = mergeFacts(pinned, { booking_dates: [focusDate] });
  pinned = mergeFacts(pinned, normalizeFacts(contact.confirmed_facts));
  const seedState = stateCode(contact.state);
  if (seedState) pinned = mergeFacts(pinned, { state: [seedState] });
  let seededLinks = 0;
  for (const row of slotLinks ?? []) {
    // Slots exist from creation with url = '', so most rows are empty.
    const slotUrl = typeof row?.url === 'string' ? row.url.trim() : '';
    if (!slotUrl) continue;
    pinned = mergeFacts(pinned, factsFromUrl(slotUrl, name));
    seededLinks += 1;
  }
  let facts = mergeFacts(pinned, normalizeFacts(contact.search_facts));

  // The FromDate/ToDate window for site searches. An ordinary run passes NO
  // dates and gets the rolling seven-years-to-today window — learned dates
  // never narrow it (a bracketing window hid a brand-new record). A focused
  // run passes its one date and gets a window hugging that arrest.
  const searchWindow = () => dateWindow(focusDate ? [focusDate] : []);
  // The dates driving derived date-addressed URLs: just the focus date on a
  // focused run, the whole variant set otherwise.
  const dateList = () => (focusDate ? [focusDate] : facts.booking_dates);

  /**
   * The states we will accept records from. A same-name stranger booked in Texas
   * is still rejected, but a client whose slots already hold a West Virginia link
   * genuinely has WV records — and the old single-state test threw those away.
   */
  const pinnedStates = pinned.state;
  const stateConflicts = (rowStates: string[]) =>
    pinnedStates.length > 0 &&
    rowStates.length > 0 &&
    !rowStates.some((st) => pinnedStates.includes(st));

  // Whether a site pinned to a state (state- or county-scoped) is worth a
  // request for THIS contact. Unlike stateConflicts(), which only rejects a
  // KNOWN-but-different state, this REQUIRES a positive match: a contact with no
  // state on file skips state/county sites entirely rather than spending a
  // billable request on, say, a Georgia paper for a lead we cannot place in
  // Georgia. National sites (no scope_state) are always eligible.
  const siteStateAllowed = (scopeState: string | null | undefined): boolean => {
    const code = stateCode(scopeState);
    if (!code) return true; // national / unscoped / unparseable → always eligible
    return pinnedStates.includes(code);
  };

  if (seededLinks) {
    await logDebug({
      source: 'deep-search:seed',
      message: `Seeded from ${seededLinks} confirmed link(s): ${
        [
          pinned.county.length ? `county ${pinned.county.join('/')}` : null,
          pinned.state.length ? `state ${pinned.state.join('/')}` : null,
          pinned.middle.length ? `middle ${pinned.middle.join('/')}` : null,
          pinned.booking_dates.length ? `dates ${pinned.booking_dates.join('/')}` : null,
        ]
          .filter(Boolean)
          .join(', ') || 'no new facts'
      }`,
      contactId,
    });
  }

  const [
    { data: siteRows, error: siteRowsError },
    { data: ruleRows, error: ruleRowsError },
    { data: existing, error: existingError },
    { data: confirmedRows, error: confirmedRowsError },
  ] = await Promise.all([
      supabase.from('probe_sites').select('*').order('scope'),
      supabase.from('url_rules').select('*'),
      supabase
        .from('search_candidates')
        .select('canonical_url')
        .eq('contact_id', contactId)
        .limit(5_000),
      supabase
        .from('search_candidates')
        .select('url')
        .eq('contact_id', contactId)
        .eq('status', 'confirmed')
        .limit(20),
    ]);
  if (siteRowsError) throw new Error(`Could not load probe sites: ${siteRowsError.message}`);
  if (ruleRowsError) throw new Error(`Could not load URL rules: ${ruleRowsError.message}`);
  if (existingError) {
    throw new Error(`Could not load existing search candidates: ${existingError.message}`);
  }
  if (confirmedRowsError) {
    throw new Error(`Could not load confirmed search candidates: ${confirmedRowsError.message}`);
  }

  // Inactive sites still matter: they are the SERP-fallback and id-pivot
  // targets. Only direct probing is limited to the active ones.
  const sitesAll = (siteRows ?? []) as ProbeSite[];
  const sites = sitesAll.filter((s) => s.active);
  const rules = (ruleRows ?? []) as UrlRule[];
  const seen = new Set((existing ?? []).map((r: any) => r.canonical_url));
  const candidateWriter = new CandidateWriter(
    supabase,
    opts?.jobId
      ? {
          jobId: opts.jobId,
          worker: opts.jobWorker!,
          attempt: opts.jobAttempt!,
        }
      : undefined
  );

  // Sites re-probes skip because a record is already confirmed there (computed
  // from confirmedUrls, built below for mining). See siteHasConfirmedRecord.
  let confirmedSkips = 0;

  let probed = 0;
  let blocked = 0;
  let browserOnlySkips = 0;
  let candidates = 0;
  let rounds = 0;
  let serpFallbacks = 0;
  let pivots = 0;
  const blockedDomains = new Set<string>();
  const familyIds = new Map<string, Set<string>>();
  const unindexedPrioritySites: string[] = [];
  let derived = 0;
  let siteSearches = 0;
  // A no-result is trustworthy only when at least one external source actually
  // answered and was readable. Otherwise a total browser/provider outage looks
  // exactly like a legitimate search with zero matches.
  let discoveryAttempts = 0;
  let discoverySuccesses = 0;
  const discoveryFailures: string[] = [];
  const recordDiscoveryFailure = (source: string, reason: string) => {
    if (discoveryFailures.length < 6) {
      discoveryFailures.push(`${source}: ${reason}`.slice(0, 500));
    }
  };
  // Domains that produced at least one hit, so we know which sites are worth
  // handing the operator a 'see everything on this site' link for.
  const sitesWithHits = new Set<string>();
  // Distinct states among accepted candidates. Two states with nothing pinned
  // means the queue plausibly holds TWO different people, and chaining any
  // deeper would dig into whichever identity got in first — which is exactly
  // how a common name went to Arkansas while the client was in Florida. The
  // run keeps COLLECTING under ambiguity; it stops COMPOUNDING (county round,
  // derived pages, id pivots) and flags the contact to pick an identity.
  const statesSeen = new Set<string>();
  const ambiguous = () => pinnedStates.length === 0 && statesSeen.size >= 2;

  /* -- Mine the pages we KNOW are this person's -----------------------------
     A confirmed record page usually lists the person's OTHER arrests (the
     arrests.org "other arrests" section; a mugshots.zone search view's rows),
     and those listings are more trustworthy than anything a name search
     returns: the person's own page vouches for them. Each listing becomes a
     candidate, and its booking date lands in the facts — which is what the
     per-arrest branch buttons in the panel run on.

     Trusted sources ONLY: pages fetched from configured probe-site domains.
     SERP titles and snippets are never mined — they mix people too freely.
     Runs before the probe rounds so a mined county or date steers them. */
  const MAX_CONFIRMED_PAGE_FETCHES = 3;
  const confirmedUrls = [
    ...new Set(
      [
        ...((confirmedRows ?? []) as any[]).map((r) => String(r?.url ?? '').trim()),
        ...(slotLinks ?? []).map((r: any) => String(r?.url ?? '').trim()),
      ].filter(Boolean)
    ),
  ];
  // A re-run skips re-SEARCHING a site that already holds a confirmed record for
  // this contact (the record won't change), saving the fetch and any billable
  // fallback. fullReprobe forces a full sweep. Note this gates only the probe
  // loop below — the mining loop above still harvests OTHER arrests from these
  // same confirmed pages, which is the opposite of redundant.
  const siteHasConfirmedRecord = (domain: string) =>
    !opts?.fullReprobe && confirmedUrls.some((u) => urlOnDomain(u, domain));
  let minedPages = 0;
  let minedListings = 0;
  for (const pageUrl of confirmedUrls) {
    if (minedPages >= MAX_CONFIRMED_PAGE_FETCHES) break;
    // Mining is a bonus phase and can cost a browser fetch plus an extraction
    // call per page; the probe rounds behind it are the core of the run. So it
    // only runs while a comfortable margin remains — this is what let mining
    // eat the whole window and starve the probes on its first night out.
    if (outOfTime() || msLeft() < 60_000) break;
    const site = sitesAll.find((s) => urlOnDomain(pageUrl, s.domain));
    if (!site) continue; // a news article or social post has no roster to mine
    minedPages += 1;
    discoveryAttempts += 1;

    let outcome: Awaited<ReturnType<typeof fetchProbePage>>;
    try {
      outcome = await fetchProbePage(pageUrl, {
        render: site.needs_render,
        needsBrowser: site.needs_browser,
        signal,
      });
    } catch (e) {
      // An abort mid-fetch (deadline, lease loss) concludes the run; it must
      // never destroy it.
      outcome = { ok: false, reason: errorMessage(e), blocked: false };
    }
    if (!outcome.ok) {
      recordDiscoveryFailure(`${site.domain} confirmed page`, outcome.reason);
      await logProbeFailure(site.domain, pageUrl, outcome.reason, contactId);
      continue;
    }
    let rows: RawRow[] = [];
    try {
      const pageText = stripToText(outcome.html, pageUrl);
      const parsed = await rowsFromPage(pageText, pageUrl, site.domain, name, contactId, {
        signal,
        requestKey: opts?.requestKey ? `${opts.requestKey}:mine:${minedPages}` : undefined,
      });
      rows = parsed.rows;
      if (parsed.llmFacts) facts = mergeFacts(facts, parsed.llmFacts);
    } catch (e) {
      recordDiscoveryFailure(`${site.domain} confirmed page parser`, errorMessage(e));
      await logDebug({
        source: 'deep-search:mine',
        message: `Could not read the confirmed page on ${site.domain}: ${errorMessage(e)}`,
        context: { url: pageUrl },
        contactId,
      });
      continue;
    }
    discoverySuccesses += 1;

    for (const row of rows) {
      const canonical = canonicalUrl(row.url);
      if (!canonical || seen.has(canonical)) continue;
      // A search page or sitemap is never a finding — its URL carrying the
      // name is the only reason it would score.
      if (isNonRecordUrl(row.url)) continue;
      const haystack = `${row.text} ${row.url}`;
      const rowFacts = mergeFacts(
        mergeFacts({ ...EMPTY_FACTS }, factsFromUrl(row.url, name)),
        factsFromText(row.text, name)
      );
      if (stateConflicts(rowFacts.state)) continue;
      const scored = scoreCorroboration(haystack, name, mergeFacts(facts, rowFacts));
      if (scored.confidence < MIN_CONFIDENCE) continue;

      const rule = matchUrlRule(row.url, rules);
      await candidateWriter.add({
        contact_id: contactId,
        url: row.url,
        canonical_url: canonical,
        title: row.text.slice(0, 300) || null,
        snippet:
          "listed on a page already confirmed as this person's — usually another arrest of the same person",
        source: 'probe',
        source_detail: `${site.domain} (confirmed page)`,
        round: 0,
        confidence: scored.confidence,
        matched_facts: scored.matched,
        url_rule_id: rule?.id ?? null,
      });
      seen.add(canonical);
      candidates += 1;
      minedListings += 1;
      sitesWithHits.add(site.domain);
      facts = mergeFacts(facts, rowFacts);
      for (const st of rowFacts.state) statesSeen.add(st);
      rememberFamilyIds(familyIds, site.family, rowFacts.record_ids);
    }
  }
  if (minedListings) {
    await logDebug({
      source: 'deep-search:mine',
      message: `Confirmed page(s) listed ${minedListings} further record(s) — likely additional arrests of this person. Their dates now carry branch buttons on the Booked row.`,
      contactId,
    });
  }

  for (const round of [0, 1] as const) {
    // The county round runs on facts round 0 accumulated — under ambiguity
    // those facts mix two people, so probing them would compound the mix.
    if (round === 1 && ambiguous()) {
      await logDebug({
        source: 'deep-search:facts',
        message: `Chaining stopped: candidates span ${[...statesSeen].sort().join(', ')} with nothing confirmed — pick the right identity in the panel, then re-run`,
        contactId,
      });
      break;
    }
    // Round 0: nothing needed, or the lead's own state. Round 1: county-scoped
    // sites, now that round 0 has probably supplied a county.
    const roundSites = sites.filter((s) =>
      round === 0 ? s.scope !== 'county' : s.scope === 'county'
    );
    if (!roundSites.length) continue;

    const window = searchWindow();
    const targets: { site: ProbeSite; url: string }[] = [];
    for (const site of roundSites) {
      // A state/county-pinned site runs only for a contact we can place in that
      // state; with no state on file it is skipped, not guessed. National sites
      // (no scope_state) are unaffected.
      if (!siteStateAllowed(site.scope_state)) continue;
      // Already have a confirmed record here: re-searching it can only re-find
      // the same page, so skip the probe (its page is still mined below for
      // OTHER arrests). fullReprobe empties confirmedUrls, so this never fires.
      if (siteHasConfirmedRecord(site.domain)) {
        confirmedSkips += 1;
        continue;
      }
      const states = site.scope_state
        ? [site.scope_state]
        : facts.state.length
          ? facts.state
          : [null];
      const counties = site.scope_county
        ? [site.scope_county]
        : facts.county.length
          ? facts.county
          : [null];

      for (const state of states) {
        for (const county of counties) {
          const url = buildProbeUrl(site.search_template, name, county, state, window);
          if (url && !targets.some((t) => t.url === url)) targets.push({ site, url });
        }
      }
    }
    if (!targets.length) continue;
    rounds += 1;

    for (const { site, url } of targets) {
      if (outOfTime()) break;
      if (probed >= MAX_PROBES_PER_RUN) break;
      probed += 1;
      discoveryAttempts += 1;
      await sleep(PER_DOMAIN_DELAY_MS);

      let outcome: Awaited<ReturnType<typeof fetchProbePage>>;
      try {
        outcome = await fetchProbePage(url, {
          render: site.needs_render,
          needsBrowser: site.needs_browser,
          signal,
        });
      } catch (e) {
        outcome = { ok: false, reason: errorMessage(e), blocked: false };
      }
      if (!outcome.ok) {
        // A browser-only site on a Chrome-less host is a standing condition of
        // the HOST, not a blocked probe: log it once per run, keep it out of
        // the blocked tally (its discovery arrives via SERP fallback), and
        // spend the remaining budget on sites that can actually answer.
        if (outcome.browserUnavailable) {
          browserOnlySkips += 1;
          // Skipped is still unread: the domain joins this run's SERP-fallback
          // pool, or the promise in the log line below would only hold for
          // sites that happen to carry the standing serp_fallback flag.
          blockedDomains.add(site.domain);
          if (browserOnlySkips === 1) {
            await logDebug({
              level: 'warn',
              source: 'deep-search:probe',
              message: `${site.domain} is browser-only and this host has no Chrome — direct probes skipped for the run; site: SERP fallback still covers it`,
              context: { url },
              contactId,
            });
          }
          continue;
        }
        blocked += 1;
        blockedDomains.add(site.domain);
        recordDiscoveryFailure(site.domain, outcome.reason);
        await logProbeFailure(site.domain, url, outcome.reason, contactId);

        // A policy refusal is BrightData's standing decision about the domain,
        // so probing it again next run would waste the same call. Flag the site
        // for SERP discovery instead of leaving it to fail forever. Additive
        // only — nothing is disabled behind the operator's back.
        if (outcome.policyBlocked && !site.serp_fallback) {
          const { error } = await supabase
            .from('probe_sites')
            .update({ serp_fallback: true })
            .eq('id', site.id);
          await logDebug({
            level: 'warn',
            source: 'deep-search:probe',
            message: error
              ? `${site.domain} is policy-blocked by BrightData; could not flag it for SERP fallback: ${error.message}`
              : `${site.domain} is policy-blocked by BrightData, so it is now flagged for site: SERP discovery instead of direct probing`,
            context: { url },
            contactId,
          });
        }
        continue;
      }

      // One unreadable page must not discard the whole sweep. An unexpected
      // error inside a single probe previously aborted the run and lost every
      // candidate the earlier probes had already found.
      let rows: RawRow[] = [];
      try {
        const pageText = stripToText(outcome.html, url);
        const parsed = await rowsFromPage(pageText, url, site.domain, name, contactId, {
          signal,
          requestKey: opts?.requestKey ? `${opts.requestKey}:extract:${probed}` : undefined,
        });
        rows = parsed.rows;
        if (parsed.llmFacts) facts = mergeFacts(facts, parsed.llmFacts);
      } catch (e) {
        recordDiscoveryFailure(`${site.domain} parser`, errorMessage(e));
        await logDebug({
          source: 'deep-search:probe',
          message: `Could not read results from ${site.domain}: ${errorMessage(e)}`,
          context: { url },
          contactId,
        });
        continue;
      }
      discoverySuccesses += 1;

      for (const row of rows) {
        const canonical = canonicalUrl(row.url);
        if (!canonical || seen.has(canonical)) continue;
        // A search page or sitemap is never a finding; treating one as a hit
        // is also what made phantom "every arrest" links appear for sites
        // with no real results.
        if (isNonRecordUrl(row.url)) continue;

        // Score against everything we know, using the row's own text plus its
        // URL — the URL alone often carries the county and date.
        const haystack = `${row.text} ${row.url}`;
        const urlFacts = factsFromUrl(row.url, name);
        const textFacts = factsFromText(row.text, name);
        const rowFacts = mergeFacts(
          mergeFacts({ ...EMPTY_FACTS }, urlFacts),
          textFacts
        );
        const scored = scoreCorroboration(haystack, name, mergeFacts(facts, rowFacts));

        // Hard reject on a state conflict: a Wake County NC client's record is
        // not the same-named person booked in Texas.
        const rowStates = rowFacts.state;
        if (stateConflicts(rowStates)) continue;
        if (scored.confidence < MIN_CONFIDENCE) continue;

        const rule = matchUrlRule(row.url, rules);
        await candidateWriter.add({
          contact_id: contactId,
          url: row.url,
          canonical_url: canonical,
          title: row.text.slice(0, 300) || null,
          source: 'probe',
          source_detail: site.domain,
          round,
          confidence: scored.confidence,
          matched_facts: scored.matched,
          url_rule_id: rule?.id ?? null,
        });
        seen.add(canonical);
        candidates += 1;
        sitesWithHits.add(site.domain);
        // A record's own page teaches us more than the listing row did.
        facts = mergeFacts(facts, rowFacts);
        for (const st of rowFacts.state) statesSeen.add(st);
        rememberFamilyIds(familyIds, site.family, rowFacts.record_ids);
      }
    }
    if (probed >= MAX_PROBES_PER_RUN) break;
  }

  /* ── One broad name search ────────────────────────────────────────────────
     Every route above is site-targeted: a record on a site we could not probe
     (a county-scoped site with no county — recentlybooked.com for an Atlanta
     lead whose county is unknown) or one not in the registry at all never
     surfaces. A single broad, UNQUOTED "name city state" query catches those.
     It reaches page two (20 results), where these records often sit, and the
     corroboration rules keep another person's record out. Highest-value SERP
     spend, so it runs before the site: fallbacks and gets a name-search
     deadline, not the tight fallback one. */
  const broadState = facts.state[0] ?? seedState ?? stateCode(contact.state) ?? null;
  if (
    !ambiguous() &&
    !outOfTime() &&
    msLeft() > BROAD_QUERY_TIMEOUT_MS + 5_000 &&
    name.first &&
    name.last
  ) {
    // Unquoted on purpose: a page rendering "Hollis, Victoria" or "VICTORIA
    // CLARK HOLLIS" does not satisfy an exact-phrase "Victoria Hollis", so the
    // auto-search's quoted query missed exactly this kind of record.
    const broadQuery = [name.first, name.last, contact.city, broadState]
      .filter(Boolean)
      .join(' ')
      .trim();
    const engines: SearchEngine[] = ['google', 'bing'];
    discoveryAttempts += engines.length;
    serpFallbacks += engines.length;
    const settled = await Promise.allSettled(
      engines.map((engine) =>
        runSerpSearch(broadQuery, {
          engine,
          numResults: MAX_BROAD_QUERY_RESULTS,
          timeoutMs: BROAD_QUERY_TIMEOUT_MS,
          signal,
          requestKey: opts?.requestKey ? `${opts.requestKey}:broad:${engine}` : undefined,
        })
      )
    );
    const broadLists: SerpResult[][] = [];
    for (const [i, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') {
        broadLists.push(outcome.value);
        discoverySuccesses += 1;
      } else {
        recordDiscoveryFailure(`${engines[i]} broad search`, errorMessage(outcome.reason));
        await logDebug({
          level: 'warn',
          source: 'deep-search:broad',
          message: `${engines[i]} broad name search failed: ${errorMessage(outcome.reason)}`,
          context: { query: broadQuery },
          contactId,
        });
      }
    }
    if (broadLists.length) {
      let broadHits = 0;
      for (const r of mergeSerpResults(broadLists)) {
        if (!r.link) continue;
        const canonical = canonicalUrl(r.link);
        if (!canonical || seen.has(canonical)) continue;
        // Social/search/sitemap pages are not a person's record page.
        if (isNonRecordUrl(r.link)) continue;
        const haystack = `${r.title} ${r.snippet} ${r.link}`;
        const rowFacts = mergeFacts(
          mergeFacts({ ...EMPTY_FACTS }, factsFromUrl(r.link, name)),
          factsFromText(`${r.title} ${r.snippet}`, name)
        );
        if (stateConflicts(rowFacts.state)) continue;
        // Same bar as every other route: surname plus at least one agreeing
        // fact, so a same-named stranger's page never lands in the queue.
        const scored = scoreCorroboration(haystack, name, mergeFacts(facts, rowFacts));
        if (scored.confidence < MIN_CONFIDENCE) continue;

        const rule = matchUrlRule(r.link, rules);
        const hitSite = sitesAll.find((s) => urlOnDomain(r.link, s.domain));
        await candidateWriter.add({
          contact_id: contactId,
          url: r.link,
          canonical_url: canonical,
          title: r.title?.slice(0, 300) || null,
          snippet: 'found via a broad name search',
          source: 'google',
          source_detail: 'broad name search',
          round: 2,
          confidence: scored.confidence,
          matched_facts: scored.matched,
          url_rule_id: rule?.id ?? null,
        });
        seen.add(canonical);
        candidates += 1;
        broadHits += 1;
        if (hitSite) {
          sitesWithHits.add(hitSite.domain);
          rememberFamilyIds(familyIds, hitSite.family ?? null, rowFacts.record_ids);
        }
        facts = mergeFacts(facts, rowFacts);
        for (const st of rowFacts.state) statesSeen.add(st);
      }
      await logDebug({
        source: 'deep-search:broad',
        message: `Broad name search "${broadQuery}" added ${broadHits} candidate(s)`,
        contactId,
      });
    }
  }

  /* ── SERP fallback for sites we cannot read directly ──────────────────────
     A challenge-walled site is not a dead end: Google has already crawled it,
     so a site:-restricted query reaches the same records without touching the
     host. Costs one SERP request per site, so it is capped and only runs for
     sites that were blocked this run or are flagged as never readable. */
  // Slots are scarce, so they go by priority (how often a site actually carries
  // client records), not by the order rows happen to arrive in. Ordering by
  // scope previously let arre.st — a 19-link mirror — crowd out arrests.org,
  // which is a fifth of all historical links.
  //
  // One query per NETWORK: mirrors of the same operator return the same records,
  // so querying siblings separately spends two requests for one set of results.
  const fallbackCandidates = [
    ...new Set([
      ...blockedDomains,
      ...sitesAll.filter((s) => s.serp_fallback).map((s) => s.domain),
    ]),
  ]
    .map((domain) => ({ domain, site: sitesAll.find((s) => s.domain === domain) }))
    // Honor state scope here too: a serp_fallback site pinned to NC must not be
    // site:-searched for a lead we cannot place in NC — the wasted, timing-out
    // queries that surfaced this. Domains with no matching site row are kept.
    .filter(({ site }) => !site || siteStateAllowed(site.scope_state))
    .sort((a, b) => (a.site?.priority ?? 100) - (b.site?.priority ?? 100));

  const usedFamilies = new Set<string>();
  const fallbackDomains: string[] = [];
  for (const { domain, site } of fallbackCandidates) {
    if (fallbackDomains.length >= MAX_SERP_FALLBACKS) break;
    if (site?.family) {
      if (usedFamilies.has(site.family)) continue;
      usedFamilies.add(site.family);
    }
    fallbackDomains.push(domain);
  }

  for (const domain of fallbackDomains) {
    // Never start a fallback that cannot finish: both engines run against a
    // FALLBACK_TIMEOUT_MS deadline, so launching one with less than that on
    // the clock only manufactures timeout warnings (last night's logs).
    if (outOfTime() || msLeft() < FALLBACK_TIMEOUT_MS + 5_000) break;
    // Unquoted on purpose. These sites render "BEACHAK GENE MICHAEL" or
    // "Beachak, Gene", so an exact-phrase "Gene Beachak" can return nothing at
    // all. site: already narrows hard, and scoreCorroboration supplies the
    // precision that the quotes would have.
    const query = `site:${domain} ${name.first} ${name.last}`.trim();
    // Both engines at once, and with a shorter deadline than a name search
    // gets. Sequentially, one slow engine added its whole timeout to the run for
    // every fallback domain — four domains of that is minutes spent waiting.
    // Each engine is metered separately, so a timeout costs an attempt that
    // BrightData does not bill (only successful requests are charged).
    const engines: SearchEngine[] = ['google', 'bing'];
    discoveryAttempts += engines.length;
    const settled = await Promise.allSettled(
      engines.map((engine) =>
        runSerpSearch(query, {
          engine,
          numResults: 20,
          timeoutMs: FALLBACK_TIMEOUT_MS,
          signal,
          requestKey: opts?.requestKey ? `${opts.requestKey}:fallback:${domain}:${engine}` : undefined,
        })
      )
    );
    serpFallbacks += engines.length;

    const lists: SerpResult[][] = [];
    for (const [i, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') {
        lists.push(outcome.value);
        discoverySuccesses += 1;
      } else {
        recordDiscoveryFailure(
          `${engines[i]} site search of ${domain}`,
          errorMessage(outcome.reason)
        );
        await logDebug({
          level: 'warn',
          source: 'deep-search:serp-fallback',
          message: `${engines[i]} site: search of ${domain} failed: ${errorMessage(outcome.reason)}`,
          context: { query },
          contactId,
        });
      }
    }
    // One engine surviving is enough; both failing means no results to judge.
    if (!lists.length) continue;
    let results = mergeSerpResults(lists);

    const site = sitesAll.find((s) => s.domain === domain);

    // Google index lag is the real limitation of the SERP route: a page that
    // exists but has not been crawled is invisible. Bing crawls these sites on
    // its own schedule and sometimes has a record Google does not, so a
    // high-value site with no Google hits gets one second look. Only for high
    // priority, and only when the first query found nothing — otherwise this
    // would double the cost of every fallback.
    // A priority site with nothing on either index usually means the page is
    // published but not yet crawled. Flagging the contact puts it in the grid's
    // Flagged view so it can be re-run in a few days, which is the only real
    // answer to index lag on a host we are not allowed to fetch directly.
    if (!results.length && (site?.priority ?? 100) <= 20) {
      unindexedPrioritySites.push(domain);
    }

    for (const r of results) {
      if (!r.link) continue;
      const canonical = canonicalUrl(r.link);
      if (!canonical || seen.has(canonical)) continue;
      // Google indexes these sites' sitemap XMLs and search pages too.
      if (isNonRecordUrl(r.link)) continue;
      // Google will return near-miss results for a site: query; the corroboration
      // rules are what keep another person's record out.
      const haystack = `${r.title} ${r.snippet} ${r.link}`;
      const rowFacts = mergeFacts(
        mergeFacts({ ...EMPTY_FACTS }, factsFromUrl(r.link, name)),
        factsFromText(`${r.title} ${r.snippet}`, name)
      );
      if (stateConflicts(rowFacts.state)) continue;
      const scored = scoreCorroboration(haystack, name, mergeFacts(facts, rowFacts));
      if (scored.confidence < MIN_CONFIDENCE) continue;

      const rule = matchUrlRule(r.link, rules);
      await candidateWriter.add({
        contact_id: contactId,
        url: r.link,
        canonical_url: canonical,
        title: r.title?.slice(0, 300) || null,
        snippet: `found via site: search (the site itself blocked us)`,
        source: 'google',
        source_detail: `site:${domain}`,
        round: 2,
        confidence: scored.confidence,
        matched_facts: scored.matched,
        url_rule_id: rule?.id ?? null,
      });
      seen.add(canonical);
      candidates += 1;
      sitesWithHits.add(domain);
      facts = mergeFacts(facts, rowFacts);
      for (const st of rowFacts.state) statesSeen.add(st);
      rememberFamilyIds(familyIds, site?.family ?? null, rowFacts.record_ids);
    }
  }

  /* -- Date-addressed pages, derived rather than searched -------------------
     A daily county roster is addressed by county and date, so a name search can
     miss it even when Google has it indexed. With the county and booking date
     already in hand the URL is fully determined -- the only route left on a host
     BrightData will not fetch for us, and it costs nothing. */
  for (const site of sitesAll) {
    // Derived pages are pure fact-chaining — skipped under ambiguity for the
    // same reason the county round is.
    if (ambiguous()) break;
    if (outOfTime()) break;
    if (!site.date_url_template) continue;
    for (const isoDate of dateList().slice(0, 3)) {
      for (const county of (facts.county.length ? facts.county : [null]).slice(
        0,
        MAX_DERIVED_COUNTIES
      )) {
        const url = buildDateUrl(
          site.date_url_template,
          isoDate,
          county,
          facts.state[0] ?? seedState ?? null
        );
        if (!url) continue;
        const canonical = canonicalUrl(url);
        if (!canonical || seen.has(canonical)) continue;

        await candidateWriter.add({
          contact_id: contactId,
          url,
          canonical_url: canonical,
          title: `${site.name ?? site.domain} - ${county ?? 'county'} roster for ${isoDate}`,
          snippet:
            'derived from the known county and booking date; the daily roster lists everyone booked that day, so open it to confirm the client appears and to pick up their individual record link',
          source: 'probe',
          source_detail: `${site.domain} (derived from county + date)`,
          round: 3,
          // The page almost certainly exists, but that it shows THIS person is
          // inferred from the date rather than seen, so it stays a lead.
          confidence: 0.7,
          matched_facts: { booking_date: isoDate, ...(county ? { county } : {}) },
          url_rule_id: matchUrlRule(url, rules)?.id ?? null,
        });
        seen.add(canonical);
        candidates += 1;
        derived += 1;
        // Deliberately NOT counted as a site hit: a derived roster is a
        // lead nobody has seen, and marking it as evidence spawned "every
        // arrest" search links for sites with no real results.
      }
    }
  }

  /* -- Record-id pivots across a network ------------------------------------────────────
     Sibling sites share ids: wakencbusts .../view-full-profile.php?id=140252 and
     wakepublicrecords .../sample.php?id=140252 are one booking. Once any sibling
     gives up an id, the rest are addressable with no request at all. */
  for (const [family, ids] of familyIds) {
    // Same reason as above: the ids may belong to two different people.
    if (ambiguous()) break;
    if (outOfTime()) break;
    for (const site of sitesAll) {
      if (site.family !== family || !site.record_url_template) continue;
      for (const id of ids) {
        const url = buildRecordUrl(site.record_url_template, id, facts.county[0] ?? null);
        if (!url) continue;
        const canonical = canonicalUrl(url);
        if (!canonical || seen.has(canonical)) continue;

        await candidateWriter.add({
          contact_id: contactId,
          url,
          canonical_url: canonical,
          title: `${site.name ?? site.domain} — record ${id}`,
          snippet:
            'derived from a sibling site sharing this record id; open it to confirm the record exists',
          source: 'probe',
          source_detail: `${site.domain} (id pivot, ${family})`,
          round: 3,
          // Deliberately below a fetched hit: the id match is strong evidence but
          // the page itself has not been seen, so it is a lead, not a finding.
          confidence: 0.7,
          matched_facts: { record_id: id, family },
          url_rule_id: matchUrlRule(url, rules)?.id ?? null,
        });
        seen.add(canonical);
        candidates += 1;
        pivots += 1;
        // Same as derived pages: an unseen pivot is a lead, not a site hit.
      }
    }
  }

  /* -- One "all arrests on this site" link per site that had a hit -----------
     A record page proves one booking; the site's own search page shows whether
     the person has MORE. That is the view worth opening by hand, and it is
     derivable from the name alone, so it works even on a host we cannot fetch:
     the operator's browser has no policy problem.

     Emitted only for sites that actually produced evidence, and marked as a
     search VIEW rather than a finding — a search URL is not removable content,
     so it must never land in a link slot. */
  for (const site of sitesAll) {
    if (outOfTime()) break;
    if (!site.search_template || !sitesWithHits.has(site.domain)) continue;
    const url = buildProbeUrl(
      site.search_template,
      name,
      facts.county[0] ?? null,
      facts.state[0] ?? seedState ?? null,
      searchWindow()
    );
    if (!url) continue;
    const canonical = canonicalUrl(url);
    if (!canonical || seen.has(canonical)) continue;

    await candidateWriter.add({
      contact_id: contactId,
      url,
      canonical_url: canonical,
      title: `${site.name ?? site.domain} - every arrest listed for this person`,
      snippet:
        'search view, not a page to remove: open it to see whether this person has more than one arrest on this site',
      source: 'probe',
      source_detail: `${site.domain} (site search)`,
      round: 4,
      // Zero on purpose: this is a tool link, not a scored finding, so it sorts
      // below real candidates and cannot be mistaken for one.
      confidence: 0,
      matched_facts: { kind: 'site_search' },
    });
    seen.add(canonical);
    siteSearches += 1;
  }
  await candidateWriter.flush();
  // Observe a deadline that fired during the final cheap phases even if no loop
  // happened to call outOfTime() afterward.
  outOfTime();
  if (opts?.signal?.aborted) {
    throw opts.signal.reason ?? new Error('Deep-search job lease was lost');
  }
  // A deadline is a safe partial completion only after at least one source
  // answered. If every source timed out, there is no trustworthy partial result
  // to turn green; leave the job failed/retryable and surface the outage.
  const merged = normalizeFacts(facts);
  const factsChanged = !factsAreEqual(normalizeFacts(contact.search_facts), merged);
  const hasPartialResults = candidates > 0 || factsChanged;
  let healthWarning: string | null = null;
  if (discoverySuccesses === 0) {
    const detail = discoveryFailures.length
      ? ` ${discoveryFailures.join(' | ')}`
      : '';
    const message = discoveryAttempts > 0
      ? `Deep search could not read any external source (${discoveryAttempts} failed attempt(s)); ` +
        `the run was not marked complete.${detail}`
      : `Deep search had no runnable external source (${sites.length} active probe site(s)); ` +
        'check probe-site configuration and required state/county facts. The run was not marked complete.';
    if (hasPartialResults) {
      healthWarning =
        `Partial deep search: no external source completed, but ${candidates} candidate(s) ` +
        `${factsChanged ? 'and newly learned facts were' : 'were'} retained. ` +
        'Confirm the useful facts, then run a secondary search.';
    }
    await logDebug({
      level: hasPartialResults ? 'warn' : 'error',
      source: 'deep-search:health',
      message: healthWarning ? `${message} ${healthWarning}` : message,
      context: {
        attempts: discoveryAttempts,
        successes: discoverySuccesses,
        failures: discoveryFailures,
        partial_candidates: candidates,
        facts_changed: factsChanged,
      },
      contactId,
    }).catch(() => {});
    if (!hasPartialResults) throw new Error(message);
  } else if (discoveryFailures.length || deadlineHit) {
    healthWarning =
      `Partial deep search: ${discoverySuccesses} of ${discoveryAttempts} external source ` +
      `attempt(s) completed${deadlineHit ? ' before the time window closed' : ''}. ` +
      'All candidates and learned facts were retained; confirm them, then run a secondary search.';
  }

  // Say plainly that the window closed early. The candidates above were still
  // flushed and the facts below still persist — a partial run is a shorter
  // run, never a lost one — and the job completes instead of retrying into
  // the same wall.
  if (deadlineHit) {
    await logDebug({
      level: 'warn',
      source: 'deep-search',
      message: `Run hit its ${Math.round(budgetMs / 1000)}s window and concluded early — everything found was kept; re-run to continue`,
      contactId,
    });
  }

  // The grid's search icon runs on these two stamps: queued ⇒ amber, searched
  // ⇒ green. Stamped at conclusion so a partial run counts — it kept its
  // findings. For queued work, migration 0028 commits these stamps, the exact
  // queue attempt, and the facts in one transaction.
  // Reuses the existing search_flag, so these land in the contacts grid's
  // Flagged view with the reason on hover — no new surface to learn. Ambiguity
  // outranks index lag: an unresolved identity makes every other follow-up
  // premature, and choosing a profile in the panel clears this flag.
  const nextFlag =
    [
      ambiguous()
        ? `Multiple identities found (${[...statesSeen].sort().join(', ')}) — pick the right one in the panel, then re-run`
        : null,
      unindexedPrioritySites.length
        ? `Not yet indexed on ${unindexedPrioritySites.join(', ')} — re-run deep search in a few days`
        : null,
      healthWarning,
    ]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 500) || null;
  if (opts?.jobId) {
    const { data: committed, error } = await supabase.rpc('finish_deep_search_attempt', {
      p_contact_id: contactId,
      p_job_id: opts.jobId,
      p_worker: opts.jobWorker!,
      p_attempt_count: opts.jobAttempt!,
      p_search_facts: merged,
      p_search_flag: nextFlag,
    });
    if (error) throw new Error(`Could not finalize deep-search state: ${error.message}`);
    if (committed !== true) throw new Error('Deep-search attempt lost its lease before completion');
  } else if (!factsAreEqual(normalizeFacts(contact.search_facts), merged)) {
    const { error } = await supabase.from('contacts').update({ search_facts: merged }).eq('id', contactId);
    if (error) throw new Error(`Could not persist search facts: ${error.message}`);
  }

  const learned = [
    merged.middle.length ? `middle ${merged.middle.join('/')}` : '',
    merged.county.length ? `county ${merged.county.join('/')}` : '',
    merged.booking_dates.length ? `booked ${merged.booking_dates.join('/')}` : '',
  ]
    .filter(Boolean)
    .join(', ');

  await logActivity({
    contactId,
    actorId,
    type: 'search',
    description:
      `Deep search${focusDate ? ` focused on the ${focusDate} arrest` : ''} probed ${probed} site search page(s)` +
      `${blocked ? ` (${blocked} unreadable)` : ''}` +
      `${minedPages ? `, read ${minedPages} confirmed page(s) — ${minedListings} further listing(s), usually other arrests` : ''}` +
      `${serpFallbacks ? `, searched ${serpFallbacks} blocked site(s) via Google` : ''}` +
      `${pivots ? `, derived ${pivots} sibling record(s) from shared ids` : ''}` +
      `${derived ? `, built ${derived} date-addressed page(s) from county + booking date` : ''}` +
      `${siteSearches ? `, ${siteSearches} site search link(s) to check for further arrests` : ''}` +
      `${confirmedSkips ? `, skipped ${confirmedSkips} site(s) already holding a confirmed record` : ''}` +
      `: ${candidates} new candidate(s) for review${learned ? `. Learned: ${learned}` : ''}` +
      `${ambiguous() ? `. Candidates span ${[...statesSeen].sort().join(', ')} — pick the right identity in the panel` : ''}` +
      `${deadlineHit ? '. Hit the time limit — partial results; re-run to continue' : ''}` +
      `${healthWarning ? `. ${healthWarning}` : ''}`,
    meta: {
      probed,
      blocked,
      candidates,
      rounds,
      serpFallbacks,
      pivots,
      derived,
      siteSearches,
      confirmedSkips,
      minedPages,
      minedListings,
      focusDate,
      partialWarning: healthWarning,
      facts: merged,
    },
  }).catch(async (error) => {
    // The exact queue attempt and contact state are already committed. An
    // optional audit-row failure must not turn that completed job into a false
    // retry/failure; retain observability in the debug log instead.
    await logDebug({
      level: 'warn',
      source: 'deep-search:activity',
      message: `Deep search completed but activity logging failed: ${errorMessage(error)}`,
      contactId,
    }).catch(() => {});
  });

  return {
    probed,
    blocked,
    candidates,
    facts: merged,
    rounds,
    serpFallbacks,
    pivots,
    derived,
    siteSearches,
  };
}

/** Never lets a probe failure bubble into a webhook or a job retry storm. */
export async function runDeepSearchSafely(contactId: string) {
  try {
    return await runDeepSearchForContact(contactId);
  } catch (e) {
    await logDebug({
      source: 'deep-search',
      message: errorMessage(e),
      contactId,
    });
    return null;
  }
}

/**
 * Turns SERP results that matched NO url_rule into reviewable candidates.
 *
 * The auto-search keeps only results whose domain an admin marked relevant,
 * which is right for filling link slots but silently discards the ~10% of cases
 * where the arrest surfaces on a news site or a social post instead. Those
 * leftovers are classified once, in a single batched call, and the hits land in
 * the same review queue as probe results. No additional SERP requests.
 *
 * Results whose domain has a rule marked irrelevant are left out entirely — an
 * admin's exclusion is not the classifier's to overturn.
 */
export async function captureUnruledSerpCandidates(
  contactId: string,
  contactName: string,
  results: { link: string; title: string; snippet: string; engine: string }[],
  rules: UrlRule[],
  query: string,
  opts?: { signal?: AbortSignal; requestKey?: string }
): Promise<number> {
  const name = splitName(contactName);
  if (!name.last || !results.length) return 0;

  const unruled = results.filter((r) => r.link && !matchUrlRule(r.link, rules)).slice(0, 20);
  if (!unruled.length) return 0;

  const supabase = createAdminClient();
  const { data: contact, error: contactError } = await supabase
    .from('contacts')
    .select('search_facts, confirmed_facts, state')
    .eq('id', contactId)
    .maybeSingle();
  if (contactError) {
    throw new Error(`Could not load contact facts for SERP classification: ${contactError.message}`);
  }
  // Same precedence as a full run: confirmed facts and links first, so the
  // classifier judges against what a human has actually verified.
  const { data: slotLinks, error: slotLinksError } = await supabase
    .from('contact_links')
    .select('url')
    .eq('contact_id', contactId);
  if (slotLinksError) {
    throw new Error(
      `Could not load confirmed links for SERP classification: ${slotLinksError.message}`
    );
  }

  let pinned: SearchFacts = { ...EMPTY_FACTS };
  pinned = mergeFacts(pinned, normalizeFacts(contact?.confirmed_facts));
  const seedState = stateCode(contact?.state);
  if (seedState) pinned = mergeFacts(pinned, { state: [seedState] });
  for (const row of slotLinks ?? []) {
    const slotUrl = typeof row?.url === 'string' ? row.url.trim() : '';
    if (slotUrl) pinned = mergeFacts(pinned, factsFromUrl(slotUrl, name));
  }
  let facts = mergeFacts(pinned, normalizeFacts(contact?.search_facts));

  const verdicts = await classifySerpResults(
    unruled.map((r) => ({ url: r.link, title: r.title, snippet: r.snippet })),
    name,
    facts,
    contactId,
    opts
  );
  if (!verdicts?.length) return 0;

  let stored = 0;
  const candidateRows: Record<string, any>[] = [];
  for (const v of verdicts) {
    if (v.kind === 'other') continue;
    const r = unruled[v.i];
    if (!r) continue;
    // The classifier judges relevance, not page KIND — a sitemap XML full of
    // arrest slugs reads as extremely relevant. Structure is ours to check.
    if (isNonRecordUrl(r.link)) continue;
    const haystack = `${r.title} ${r.snippet} ${r.link}`;
    const scored = scoreCorroboration(haystack, name, facts);
    // The classifier's judgement is not a substitute for the surname rule.
    if (scored.confidence < MIN_CONFIDENCE) continue;

    candidateRows.push({
      contact_id: contactId,
      url: r.link,
      canonical_url: canonicalUrl(r.link),
      title: r.title?.slice(0, 300) || null,
      snippet: `${v.kind}: ${v.reason}`.slice(0, 500),
      source: r.engine === 'bing' ? 'bing' : 'google',
      source_detail: query.slice(0, 200),
      round: 2,
      confidence: scored.confidence,
      matched_facts: { ...scored.matched, kind: v.kind },
    });
    stored += 1;

    // Social and news URLs are dense with facts even when the page is closed to
    // us: a Busted Newspaper Facebook post is
    //   /BustedNewspaperArlingtonCountyVA/posts/remmark-jeffery-colin-mugshot-
    //   2025-09-28-225000-arlington-county-virginia-arrest/
    // which gives the middle name, county, state, and booking date at once.
    // Feeding those back means a social hit can unlock the county-scoped probes.
    facts = mergeFacts(
      facts,
      mergeFacts(
        mergeFacts({ ...EMPTY_FACTS }, factsFromUrl(r.link, name)),
        factsFromText(`${r.title} ${r.snippet}`, name)
      )
    );
  }
  if (candidateRows.length) {
    const { error } = await supabase
      .from('search_candidates')
      .upsert(candidateRows, { onConflict: 'contact_id,canonical_url', ignoreDuplicates: true });
    if (error) throw new Error(`Could not store classified candidates: ${error.message}`);
  }

  const merged = normalizeFacts(facts);
  const { error: factError } = await supabase
    .from('contacts')
    .update({ search_facts: merged })
    .eq('id', contactId);
  if (factError) {
    await logDebug({
      level: 'error',
      source: 'deep-search:facts',
      message: `Could not persist facts learned from SERP results: ${factError.message}`,
      contactId,
    });
    throw new Error(`Could not persist facts learned from SERP results: ${factError.message}`);
  }
  return stored;
}
