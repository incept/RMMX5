import { createAdminClient } from '@/lib/supabase/server';
import { canonicalUrl } from '@/lib/integrations/brightdata';
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

interface ProbeSite {
  id: string;
  domain: string;
  name: string | null;
  search_template: string;
  scope: 'national' | 'state' | 'county';
  scope_state: string | null;
  scope_county: string | null;
  family: string | null;
}

export interface DeepSearchResult {
  probed: number;
  blocked: number;
  candidates: number;
  facts: SearchFacts;
  rounds: number;
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
    supabase.from('probe_sites').select('*').eq('active', true).order('scope'),
    supabase.from('url_rules').select('*'),
    supabase.from('search_candidates').select('canonical_url').eq('contact_id', contactId),
  ]);

  const sites = (siteRows ?? []) as ProbeSite[];
  const rules = (ruleRows ?? []) as UrlRule[];
  const seen = new Set((existing ?? []).map((r: any) => r.canonical_url));

  let probed = 0;
  let blocked = 0;
  let candidates = 0;
  let rounds = 0;

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

      const outcome = await fetchProbePage(url);
      if (!outcome.ok) {
        blocked += 1;
        await logProbeFailure(site.domain, url, outcome.reason, contactId);
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
          // A record's own page teaches us more than the listing row did.
          facts = mergeFacts(facts, rowFacts);
        }
      }
    }
    if (probed >= MAX_PROBES_PER_RUN) break;
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
      `${blocked ? ` (${blocked} unreadable)` : ''}: ` +
      `${candidates} new candidate(s) for review${learned ? `. Learned: ${learned}` : ''}`,
    meta: { probed, blocked, candidates, rounds, facts: merged },
  });

  return { probed, blocked, candidates, facts: merged, rounds };
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
