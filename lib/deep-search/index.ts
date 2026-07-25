import { createAdminClient } from '@/lib/supabase/server';
import { canonicalUrl, mergeSerpResults, runSerpSearch } from '@/lib/integrations/brightdata';
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
import { factsFromLlmRows, factsFromText, factsFromUrl } from './extract.ts';
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
/** Surname plus at least one more agreeing signal. Surname alone scores 0.4. */
const MIN_CONFIDENCE = 0.55;
/** site: queries cost a SERP request each, so the per-run count is bounded. */
const MAX_SERP_FALLBACKS = 4;

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
  contactId: string
): Promise<{ rows: RawRow[]; llmFacts: SearchFacts | null }> {
  const llmRows = await extractRowsWithLlm(pageText, name, contactId);
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
  actorId?: string | null
): Promise<DeepSearchResult> {
  const supabase = createAdminClient();

  const { data: contact } = await supabase
    .from('contacts')
    .select('id, name, city, state, search_facts')
    .eq('id', contactId)
    .single();
  if (!contact?.name) throw new Error('Contact has no name to search for');

  const name = splitName(contact.name);
  if (!name.last) throw new Error(`"${contact.name}" has no surname to corroborate matches against`);

  let facts = normalizeFacts(contact.search_facts);
  // Seed from the contact record: the state the lead's IP resolved to is the
  // first corroborator, and it is what keeps a same-name stranger out.
  const seedState = stateCode(contact.state);
  if (seedState) facts = mergeFacts(facts, { state: [seedState] });

  const [{ data: siteRows }, { data: ruleRows }, { data: existing }] = await Promise.all([
    supabase.from('probe_sites').select('*').order('scope'),
    supabase.from('url_rules').select('*'),
    supabase.from('search_candidates').select('canonical_url').eq('contact_id', contactId),
  ]);

  // Inactive sites still matter: they are the SERP-fallback and id-pivot
  // targets. Only direct probing is limited to the active ones.
  const sitesAll = (siteRows ?? []) as ProbeSite[];
  const sites = sitesAll.filter((s) => s.active);
  const rules = (ruleRows ?? []) as UrlRule[];
  const seen = new Set((existing ?? []).map((r: any) => r.canonical_url));

  let probed = 0;
  let blocked = 0;
  let candidates = 0;
  let rounds = 0;
  let serpFallbacks = 0;
  let pivots = 0;
  const blockedDomains = new Set<string>();
  const familyIds = new Map<string, Set<string>>();
  const unindexedPrioritySites: string[] = [];
  let derived = 0;
  let siteSearches = 0;
  // Domains that produced at least one hit, so we know which sites are worth
  // handing the operator a 'see everything on this site' link for.
  const sitesWithHits = new Set<string>();

  for (const round of [0, 1] as const) {
    // Round 0: nothing needed, or the lead's own state. Round 1: county-scoped
    // sites, now that round 0 has probably supplied a county.
    const roundSites = sites.filter((s) =>
      round === 0 ? s.scope !== 'county' : s.scope === 'county'
    );
    if (!roundSites.length) continue;

    const window = dateWindow(facts.booking_dates);
    const targets: { site: ProbeSite; url: string }[] = [];
    for (const site of roundSites) {
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
          // A site pinned to one state is irrelevant to a lead in another.
          if (site.scope_state && seedState && site.scope_state !== seedState) continue;
          const url = buildProbeUrl(site.search_template, name, county, state, window);
          if (url && !targets.some((t) => t.url === url)) targets.push({ site, url });
        }
      }
    }
    if (!targets.length) continue;
    rounds += 1;

    for (const { site, url } of targets) {
      if (probed >= MAX_PROBES_PER_RUN) break;
      probed += 1;
      await sleep(PER_DOMAIN_DELAY_MS);

      const outcome = await fetchProbePage(url, { render: site.needs_render });
      if (!outcome.ok) {
        blocked += 1;
        blockedDomains.add(site.domain);
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
        const parsed = await rowsFromPage(pageText, url, site.domain, name, contactId);
        rows = parsed.rows;
        if (parsed.llmFacts) facts = mergeFacts(facts, parsed.llmFacts);
      } catch (e) {
        await logDebug({
          source: 'deep-search:probe',
          message: `Could not read results from ${site.domain}: ${errorMessage(e)}`,
          context: { url },
          contactId,
        });
        continue;
      }

      for (const row of rows) {
        const canonical = canonicalUrl(row.url);
        if (!canonical || seen.has(canonical)) continue;

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
        if (seedState && rowStates.length && !rowStates.includes(seedState)) continue;
        if (scored.confidence < MIN_CONFIDENCE) continue;

        const rule = matchUrlRule(row.url, rules);
        const { error } = await supabase.from('search_candidates').insert({
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
        if (error && error.code !== '23505') {
          await logDebug({
            source: 'deep-search:candidate',
            message: `Could not store candidate: ${error.message}`,
            context: { url: row.url, domain: site.domain },
            contactId,
          });
          continue;
        }
        seen.add(canonical);
        if (!error) {
          candidates += 1;
          sitesWithHits.add(site.domain);
          // A record's own page teaches us more than the listing row did.
          facts = mergeFacts(facts, rowFacts);
          rememberFamilyIds(familyIds, site.family, rowFacts.record_ids);
        }
      }
    }
    if (probed >= MAX_PROBES_PER_RUN) break;
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
    // Unquoted on purpose. These sites render "BEACHAK GENE MICHAEL" or
    // "Beachak, Gene", so an exact-phrase "Gene Beachak" can return nothing at
    // all. site: already narrows hard, and scoreCorroboration supplies the
    // precision that the quotes would have.
    const query = `site:${domain} ${name.first} ${name.last}`.trim();
    let results: Awaited<ReturnType<typeof runSerpSearch>> = [];
    try {
      results = await runSerpSearch(query, { engine: 'google', numResults: 20 });
      serpFallbacks += 1;
    } catch (e) {
      await logDebug({
        level: 'warn',
        source: 'deep-search:serp-fallback',
        message: `site: search of ${domain} failed: ${errorMessage(e)}`,
        context: { query },
        contactId,
      });
      continue;
    }

    const site = sitesAll.find((s) => s.domain === domain);

    // Google index lag is the real limitation of the SERP route: a page that
    // exists but has not been crawled is invisible. Bing crawls these sites on
    // its own schedule and sometimes has a record Google does not, so a
    // high-value site with no Google hits gets one second look. Only for high
    // priority, and only when the first query found nothing — otherwise this
    // would double the cost of every fallback.
    // Bing runs on EVERY fallback, not only when Google came back empty: the two
    // crawl these sites on different schedules and each holds records the other
    // misses, which is exactly why the auto-search queries both. Results merge
    // and dedupe, so a page both engines know about is still one candidate.
    try {
      const bing = await runSerpSearch(query, { engine: 'bing', numResults: 20 });
      serpFallbacks += 1;
      results = mergeSerpResults([results, bing]);
    } catch (e) {
      await logDebug({
        level: 'warn',
        source: 'deep-search:serp-fallback',
        message: `Bing site: search of ${domain} failed: ${errorMessage(e)}`,
        context: { query },
        contactId,
      });
    }

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
      // Google will return near-miss results for a site: query; the corroboration
      // rules are what keep another person's record out.
      const haystack = `${r.title} ${r.snippet} ${r.link}`;
      const rowFacts = mergeFacts(
        mergeFacts({ ...EMPTY_FACTS }, factsFromUrl(r.link, name)),
        factsFromText(`${r.title} ${r.snippet}`, name)
      );
      if (seedState && rowFacts.state.length && !rowFacts.state.includes(seedState)) continue;
      const scored = scoreCorroboration(haystack, name, mergeFacts(facts, rowFacts));
      if (scored.confidence < MIN_CONFIDENCE) continue;

      const rule = matchUrlRule(r.link, rules);
      const { error } = await supabase.from('search_candidates').insert({
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
      if (!error) {
        seen.add(canonical);
        candidates += 1;
        sitesWithHits.add(domain);
        facts = mergeFacts(facts, rowFacts);
        rememberFamilyIds(familyIds, site?.family ?? null, rowFacts.record_ids);
      }
    }
  }

  /* -- Date-addressed pages, derived rather than searched -------------------
     A daily county roster is addressed by county and date, so a name search can
     miss it even when Google has it indexed. With the county and booking date
     already in hand the URL is fully determined -- the only route left on a host
     BrightData will not fetch for us, and it costs nothing. */
  for (const site of sitesAll) {
    if (!site.date_url_template) continue;
    for (const isoDate of facts.booking_dates.slice(0, 3)) {
      for (const county of (facts.county.length ? facts.county : [null]).slice(0, 2)) {
        const url = buildDateUrl(
          site.date_url_template,
          isoDate,
          county,
          facts.state[0] ?? seedState ?? null
        );
        if (!url) continue;
        const canonical = canonicalUrl(url);
        if (!canonical || seen.has(canonical)) continue;

        const { error } = await supabase.from('search_candidates').insert({
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
        if (!error) {
          seen.add(canonical);
          candidates += 1;
          derived += 1;
          sitesWithHits.add(site.domain);
        }
      }
    }
  }

  /* -- Record-id pivots across a network ------------------------------------────────────
     Sibling sites share ids: wakencbusts .../view-full-profile.php?id=140252 and
     wakepublicrecords .../sample.php?id=140252 are one booking. Once any sibling
     gives up an id, the rest are addressable with no request at all. */
  for (const [family, ids] of familyIds) {
    for (const site of sitesAll) {
      if (site.family !== family || !site.record_url_template) continue;
      for (const id of ids) {
        const url = buildRecordUrl(site.record_url_template, id, facts.county[0] ?? null);
        if (!url) continue;
        const canonical = canonicalUrl(url);
        if (!canonical || seen.has(canonical)) continue;

        const { error } = await supabase.from('search_candidates').insert({
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
        if (!error) {
          seen.add(canonical);
          candidates += 1;
          pivots += 1;
          sitesWithHits.add(site.domain);
        }
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
    if (!site.search_template || !sitesWithHits.has(site.domain)) continue;
    const url = buildProbeUrl(
      site.search_template,
      name,
      facts.county[0] ?? null,
      facts.state[0] ?? seedState ?? null,
      dateWindow(facts.booking_dates)
    );
    if (!url) continue;
    const canonical = canonicalUrl(url);
    if (!canonical || seen.has(canonical)) continue;

    const { error } = await supabase.from('search_candidates').insert({
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
    if (!error) {
      seen.add(canonical);
      siteSearches += 1;
    }
  }

  // Reuses the existing search_flag, so these land in the contacts grid's
  // Flagged view with the reason on hover — no new surface to learn.
  if (unindexedPrioritySites.length) {
    const { error } = await supabase
      .from('contacts')
      .update({
        search_flag: `Not yet indexed on ${unindexedPrioritySites.join(', ')} — re-run deep search in a few days`,
        search_flagged_at: new Date().toISOString(),
      })
      .eq('id', contactId);
    if (error) {
      await logDebug({
        source: 'deep-search:facts',
        message: `Could not flag unindexed sites: ${error.message}`,
        contactId,
      });
    }
  }

  const merged = normalizeFacts(facts);
  if (!factsAreEqual(normalizeFacts(contact.search_facts), merged)) {
    const { error } = await supabase
      .from('contacts')
      .update({ search_facts: merged })
      .eq('id', contactId);
    if (error) {
      await logDebug({
        source: 'deep-search:facts',
        message: `Could not persist search facts: ${error.message}`,
        contactId,
      });
    }
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
      `Deep search probed ${probed} site search page(s)` +
      `${blocked ? ` (${blocked} unreadable)` : ''}` +
      `${serpFallbacks ? `, searched ${serpFallbacks} blocked site(s) via Google` : ''}` +
      `${pivots ? `, derived ${pivots} sibling record(s) from shared ids` : ''}` +
      `${derived ? `, built ${derived} date-addressed page(s) from county + booking date` : ''}` +
      `${siteSearches ? `, ${siteSearches} site search link(s) to check for further arrests` : ''}` +
      `: ${candidates} new candidate(s) for review${learned ? `. Learned: ${learned}` : ''}`,
    meta: {
      probed,
      blocked,
      candidates,
      rounds,
      serpFallbacks,
      pivots,
      derived,
      siteSearches,
      facts: merged,
    },
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
  query: string
): Promise<number> {
  const name = splitName(contactName);
  if (!name.last || !results.length) return 0;

  const unruled = results.filter((r) => r.link && !matchUrlRule(r.link, rules)).slice(0, 20);
  if (!unruled.length) return 0;

  const supabase = createAdminClient();
  const { data: contact } = await supabase
    .from('contacts')
    .select('search_facts, state')
    .eq('id', contactId)
    .maybeSingle();
  let facts = normalizeFacts(contact?.search_facts);
  const seedState = stateCode(contact?.state);
  if (seedState) facts = mergeFacts(facts, { state: [seedState] });

  const verdicts = await classifySerpResults(
    unruled.map((r) => ({ url: r.link, title: r.title, snippet: r.snippet })),
    name,
    facts,
    contactId
  );
  if (!verdicts?.length) return 0;

  let stored = 0;
  for (const v of verdicts) {
    if (v.kind === 'other') continue;
    const r = unruled[v.i];
    if (!r) continue;
    const haystack = `${r.title} ${r.snippet} ${r.link}`;
    const scored = scoreCorroboration(haystack, name, facts);
    // The classifier's judgement is not a substitute for the surname rule.
    if (scored.confidence < MIN_CONFIDENCE) continue;

    const { error } = await supabase.from('search_candidates').insert({
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
    if (!error) stored += 1;

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

  const merged = normalizeFacts(facts);
  const { error: factError } = await supabase
    .from('contacts')
    .update({ search_facts: merged })
    .eq('id', contactId);
  if (factError) {
    await logDebug({
      source: 'deep-search:facts',
      message: `Could not persist facts learned from SERP results: ${factError.message}`,
      contactId,
    });
  }
  return stored;
}
