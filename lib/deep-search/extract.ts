import {
  type NameParts,
  type SearchFacts,
  EMPTY_FACTS,
  mergeFacts,
  normalizeFacts,
  stateCode,
} from './facts.ts';

/**
 * Pulling facts out of what we find.
 *
 * Two tiers. Tier 1 is deterministic and free: the URL, title, and snippet we
 * already hold are dense with facts — recentlybooked puts the state and county
 * in the path, arrests.org puts the booking date there, and mugshots.zone puts
 * the middle name in both the slug and the title. Tier 2 sends a stripped page
 * to Haiku, but only when Tier 1 left gaps and only if a key is configured.
 *
 * SECURITY: page text is untrusted. Extracted values are treated strictly as
 * data — normalised, length-capped, and never interpreted as instructions.
 */

/** Words that appear next to names on these sites and are never middle names. */
const NOT_A_NAME = new Set([
  'mugshot', 'mugshots', 'arrest', 'arrested', 'arrests', 'booking', 'booked',
  'county', 'jail', 'inmate', 'inmates', 'record', 'records', 'photo', 'photos',
  'busted', 'newspaper', 'view', 'full', 'profile', 'sample', 'search', 'zone',
  'public', 'details', 'detail', 'page', 'php', 'html', 'index', 'the', 'and',
  'jr', 'sr', 'ii', 'iii', 'iv', 'unknown', 'none', 'posts', 'post', 'reels',
  'warrant', 'warrants', 'active', 'booked', 'charged', 'date', 'birth', 'old',
  'year', 'from', 'was', 'and', 'jail', 'crime', 'crimes', 'busted', 'gazette',
  // Sitemap/XML/web scaffolding — a sitemap fed to the extractor put the person's
  // name next to <loc>/<lastmod>, so "Loc" and "Lastmod" scored as middle names.
  'loc', 'lastmod', 'urlset', 'changefreq', 'priority', 'xml', 'xmlns', 'sitemap',
  'http', 'https', 'www', 'href', 'link', 'src', 'img', 'span', 'div', 'meta',
  'com', 'org', 'net', 'gov', 'edu',
  // Common filler words that are never middle names (kept conservative so real
  // name-words like May/Will/Grace/June are NOT excluded).
  'into', 'with', 'this', 'that', 'these', 'those', 'here', 'there', 'about',
]);

/**
 * Path segments that sit exactly where a county name would and are not one.
 * "virginia.arrests.org/Arrests/Jeffery_Remmark_65771891/" has no county at all,
 * and reading "Arrests" as one produced a wrong county on 197 historical links.
 */
const NOT_A_COUNTY = new Set([
  'arrest', 'arrests', 'mugshot', 'mugshots', 'record', 'records', 'search',
  'posts', 'post', 'profile', 'p', 'reels', 'photos', 'inmate', 'inmates',
  'booking', 'bookings', 'jail', 'news', 'about', 'contact', 'sample', 'view',
]);

/**
 * URLs that can never be a person's RECORD page: a site's own search results,
 * sitemaps, and feeds. The person's name sitting inside such a URL is exactly
 * what let them score as candidates — bustednewspaper.com/search/perriaye+powe/
 * carries the full name and scores 0.55 on the name alone, and an XML sitemap
 * page carries hundreds of names. This is about never presenting noise AS A
 * FINDING; the per-site "every arrest" search link is still offered, on
 * purpose, as a zero-confidence tool link.
 */
export function isNonRecordUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true; // not even a URL — certainly not a record page
  }
  const path = u.pathname.toLowerCase();
  if (/\.(xml|xsl|rss|atom)$/.test(path)) return true;
  if (/(^|\/)(sitemap[^/]*|feeds?|rss)(\/|$)/.test(path)) return true;
  if (/(^|\/)search(\/|\.\w+$|$)/.test(path)) return true;
  for (const key of ['s', 'q', 'search', 'query', 'keywords']) {
    if (u.searchParams.has(key)) return true;
  }
  return false;
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function iso(y: string | number, m: string | number, d: string | number): string | null {
  const yy = Number(y);
  const mm = Number(m);
  const dd = Number(d);
  if (!yy || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** Every booking-date spelling these sites use, normalised to ISO. */
export function findDates(text: string): string[] {
  const out: string[] = [];
  const push = (v: string | null) => {
    if (v && !out.includes(v)) out.push(v);
  };

  for (const m of text.matchAll(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](20\d{2})\b/g)) {
    push(iso(m[3], m[1], m[2])); // mm/dd/yyyy — US order, as these sites use
  }
  for (const m of text.matchAll(/\b(20\d{2})[/\-.](\d{1,2})[/\-.](\d{1,2})\b/g)) {
    push(iso(m[1], m[2], m[3]));
  }
  // bustednewspaper records and Facebook post slugs use a compact stamp:
  // "/20250928-225000/". Anchored to a plausible year so ids are not misread.
  for (const m of text.matchAll(/\b(20[0-2]\d)(\d{2})(\d{2})(?:[-_]\d{4,6})?\b/g)) {
    push(iso(m[1], m[2], m[3]));
  }
  // "/2026/April/22/" and "April 22, 2026"
  for (const m of text.matchAll(/\b(20\d{2})\/([A-Za-z]+)\/(\d{1,2})\b/g)) {
    const mi = MONTHS.indexOf(m[2].toLowerCase());
    if (mi >= 0) push(iso(m[1], mi + 1, m[3]));
  }
  for (const m of text.matchAll(/\b([A-Za-z]+)\s+(\d{1,2}),?\s+(20\d{2})\b/g)) {
    const mi = MONTHS.indexOf(m[1].toLowerCase());
    if (mi >= 0) push(iso(m[3], mi + 1, m[2]));
  }
  return out.slice(0, 6);
}

/** "... Wake County ..." → ["Wake"]. Also catches two-word counties. */
export function findCounties(text: string): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const c = titleCase(raw.replace(/[-_.]+/g, ' ').trim());
    if (c.length > 2 && !NOT_A_COUNTY.has(c.toLowerCase()) && !out.includes(c)) out.push(c);
  };
  // "Wake County" in prose, titles, and SERP snippets.
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+County\b/g)) add(m[1]);
  // Slug and handle forms, as used in Facebook post slugs and page names:
  // "…-arlington-county-virginia-arrest", "mugshots.orlando.orange.county.jail".
  for (const m of text.matchAll(/([a-z]+)[-_.]county\b/gi)) add(m[1]);
  // Camel-cased page names: "BustedNewspaperArlingtonCountyVA", "GordonCountyCrime".
  // No \b after "County" — the next character is usually another capital.
  for (const m of text.matchAll(/([A-Z][a-z]+)County(?![a-z])/g)) add(m[1]);
  return out.slice(0, 4);
}

/**
 * Middle name from a name-ish string.
 *
 * Booking sites write names in every order — "BEACHAK GENE MICHAEL" in a title,
 * "beachak-gene-michael" in a slug, "Gene Michael Beachak" in body text. Rather
 * than guess the order, find where the first and last name sit close together
 * and take the leftover name-like token in that window.
 */
export function findMiddleNames(text: string, name: NameParts): string[] {
  if (!name.first || !name.last) return [];
  // A sitemap/XML document is structure, not prose: its tag names sit right
  // beside the name in the URL slug and were being read as middle names. Don't
  // mine names out of one at all.
  if (/<\??(?:xml|urlset|sitemapindex|loc|url)\b/i.test(text)) return [];
  const tokens = text.toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 1);
  const first = name.first.toLowerCase();
  const last = name.last.toLowerCase();
  const out: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== first && tokens[i] !== last) continue;
    // Window covering "last first MIDDLE", "first MIDDLE last", "MIDDLE last first".
    for (let j = Math.max(0, i - 2); j <= Math.min(tokens.length - 1, i + 2); j++) {
      const t = tokens[j];
      if (t === first || t === last || NOT_A_NAME.has(t)) continue;
      if (!/^[a-z]+$/.test(t) || t.length < 2) continue;
      // A county name sits as close to the name as a middle name does — in
      // "BEACHAK GENE MICHAEL ... Wake County", "Wake" is two tokens from
      // "GENE". The following word is what tells them apart.
      if (tokens[j + 1] === 'county') continue;
      // "…-arlington-county-virginia-arrest": a state name is not a middle name.
      if (stateCode(t)) continue;
      // Require the other half of the name nearby, so unrelated words in a
      // listing of many people don't get picked up as a middle name.
      const windowTokens = tokens.slice(Math.max(0, j - 3), j + 4);
      if (!windowTokens.includes(first) || !windowTokens.includes(last)) continue;
      const pretty = t[0].toUpperCase() + t.slice(1);
      if (!out.includes(pretty)) out.push(pretty);
    }
  }
  return out.slice(0, 4);
}

/** Tier 1: facts sitting in a URL's own structure. */
export function factsFromUrl(url: string, name: NameParts): Partial<SearchFacts> {
  const facts: Partial<SearchFacts> = {};
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return facts;
  }
  const host = parsed.hostname.toLowerCase();
  const path = decodeURIComponent(parsed.pathname);
  const states: string[] = [];
  const counties: string[] = [];

  // "/nc/wake/gene-beachak~206_977665" — two-letter state then county.
  const segs = path.split('/').filter(Boolean);
  for (let i = 0; i < segs.length - 1; i++) {
    // Two-letter CODE only. A spelled-out state introduces a name slug instead
    // ("bustednewspaper.com/virginia/remmark-jeffery-colin/"), and treating that
    // slug as a county produced counties like "Remmark Jeffery Colin".
    if (!/^[a-z]{2}$/i.test(segs[i])) continue;
    const code = stateCode(segs[i]);
    const next = segs[i + 1];
    if (code && /^[a-z][a-z-]*$/i.test(next) && !NOT_A_COUNTY.has(next.toLowerCase())) {
      states.push(code);
      counties.push(titleCase(next.replace(/-/g, ' ')));
    }
  }
  // "northcarolina.arrests.org/Wake/2026/April/22/" — state as subdomain.
  const sub = host.split('.')[0];
  const subState = stateCode(sub);
  if (subState) {
    states.push(subState);
    if (
      segs[0] &&
      /^[A-Za-z][A-Za-z-]+$/.test(segs[0]) &&
      !NOT_A_COUNTY.has(segs[0].toLowerCase())
    ) {
      counties.push(titleCase(segs[0]));
    }
  }
  // "wakenc.mugshots.zone" — county and state fused into one subdomain label.
  // Only split a label that is not itself a state name: "virginia" would
  // otherwise decompose into county "Virgin" + state "IA".
  const fused = subState ? null : /^([a-z]{3,})([a-z]{2})$/.exec(sub);
  if (fused && stateCode(fused[2])) {
    states.push(stateCode(fused[2])!);
    counties.push(titleCase(fused[1]));
  }

  // bustednewspaper records are "/virginia/remmark-jeffery-colin/...", and
  // Facebook slugs end "...-arlington-county-virginia-arrest" — the state is
  // spelled out rather than abbreviated.
  for (const token of path.split(/[^A-Za-z]+/)) {
    if (token.length < 4) continue;
    const code = stateCode(token);
    if (code) states.push(code);
  }
  // arre.st and recentlybooked put the code in a leading segment: "/FL-1160764/"
  const lead = /^\/([A-Za-z]{2})[-/]/.exec(parsed.pathname);
  if (lead) {
    const code = stateCode(lead[1]);
    if (code) states.push(code);
  }

  // Several rules can spot the same state or county in one URL (a subdomain and
  // a path segment often agree), so collapse before returning.
  const uniq = (values: string[]) => [...new Set(values)];
  if (states.length) facts.state = uniq(states);
  if (counties.length) facts.county = uniq(counties);

  const ids: string[] = [];
  for (const m of parsed.search.matchAll(/[?&]id=([\w-]{2,24})/gi)) ids.push(m[1]);
  // recentlybooked: "/fl/sarasota/milen-santiano~56_202400009823"
  for (const m of path.matchAll(/~([\w-]{2,24})/g)) ids.push(m[1]);
  // arrests.org: "/Arrests/Jeffery_Remmark_65771891/" — trailing numeric id.
  // Skipped when a "~" id was already found, or it would also chop
  // recentlybooked's "~206_977665" down to a second, partial id.
  if (!path.includes('~')) {
    for (const m of path.matchAll(/_(\d{6,12})\/?$/g)) ids.push(m[1]);
  }
  // arre.st short links: "/FL-116076423/"
  for (const m of path.matchAll(/^\/([A-Z]{2})-(\d{6,12})\/?$/g)) ids.push(m[2]);
  if (ids.length) facts.record_ids = uniq(ids);

  const dates = findDates(path);
  if (dates.length) facts.booking_dates = dates;

  // Scoped to the one path segment that contains both the first and last name —
  // the name slug. Run across the whole path it also swallowed neighbouring
  // segments ("/VA/Arlington/JEFFERY-REMMARK~…" yielded middle names "Va" and
  // "Arlington"), because URL paths are full of tokens that sit as close to the
  // name as a real middle name does.
  const middles: string[] = [];
  if (name.first && name.last) {
    for (const seg of segs) {
      const words = seg.replace(/[-_.~]/g, ' ');
      const lower = words.toLowerCase();
      if (!lower.includes(name.first.toLowerCase())) continue;
      if (!lower.includes(name.last.toLowerCase())) continue;
      for (const m of findMiddleNames(words, name)) {
        if (!middles.includes(m)) middles.push(m);
      }
    }
  }
  if (middles.length) facts.middle = middles;

  // Social URLs carry their facts in the handle and the post slug rather than a
  // tidy path — "web.facebook.com/BustedNewspaperArlingtonCountyVA/posts/
  // remmark-jeffery-colin-mugshot-2025-09-28-225000-arlington-county-virginia-arrest".
  // Instagram is the exception: /p/{shortcode}/ says nothing, so those rely on
  // the SERP title and snippet instead.
  const slugCounties = findCounties(`${host} ${path}`);
  if (slugCounties.length) {
    facts.county = [...(facts.county ?? []), ...slugCounties];
  }

  return facts;
}

/** Tier 1: facts in a SERP title/snippet or a search-result row's text. */
export function factsFromText(text: string, name: NameParts): Partial<SearchFacts> {
  const facts: Partial<SearchFacts> = {};
  const counties = findCounties(text);
  if (counties.length) facts.county = counties;
  const dates = findDates(text);
  if (dates.length) facts.booking_dates = dates;
  const middles = findMiddleNames(text, name);
  if (middles.length) facts.middle = middles;
  return facts;
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/* ── Rows returned by the optional LLM extractor (lib/deep-search/llm.ts) ── */

export interface LlmRow {
  url?: string;
  name?: string;
  middle?: string;
  county?: string;
  state?: string;
  booking_date?: string;
  charges?: string[];
  record_id?: string;
}

/**
 * Coerces one row of model output into the shape LlmRow promises.
 *
 * The interface is a request, not a guarantee: asked for `charges` as an array,
 * the model sometimes answers with a single string ("DUI, no license"), and a
 * consumer calling .join() on it threw and aborted the whole probe run. Every
 * field is normalised once, here, so no downstream caller has to re-check —
 * which is what "treat model output as untrusted data" has to mean in practice.
 */
export function normalizeLlmRow(raw: any): LlmRow {
  const str = (v: any): string | undefined => {
    if (v == null || typeof v === 'object') return undefined;
    const s = String(v).trim();
    return s ? s.slice(0, 200) : undefined;
  };
  const charges: string[] = Array.isArray(raw?.charges)
    ? raw.charges.flatMap((c: any) => (typeof c === 'object' ? [] : [String(c)]))
    : typeof raw?.charges === 'string'
      ? // a single string may still hold several charges
        raw.charges.split(/[,;|]/)
      : [];

  return {
    url: str(raw?.url),
    name: str(raw?.name),
    middle: str(raw?.middle),
    county: str(raw?.county),
    state: str(raw?.state),
    booking_date: str(raw?.booking_date),
    record_id: str(raw?.record_id),
    charges: charges.map((c) => c.trim().slice(0, 120)).filter(Boolean).slice(0, 12),
  };
}

/** Folds LLM rows into the fact set, normalising and capping as it goes. */
export function factsFromLlmRows(rows: LlmRow[]): SearchFacts {
  let facts = { ...EMPTY_FACTS };
  for (const r of rows) {
    const code = stateCode(r.state);
    facts = mergeFacts(facts, {
      middle: r.middle ? [String(r.middle).slice(0, 40)] : [],
      county: r.county ? [String(r.county).replace(/\s*county\s*/i, '').trim().slice(0, 60)] : [],
      state: code ? [code] : [],
      booking_dates: r.booking_date ? findDates(String(r.booking_date)) : [],
      record_ids: r.record_id ? [String(r.record_id).slice(0, 24)] : [],
      charges: Array.isArray(r.charges) ? r.charges.map((c) => String(c).slice(0, 120)) : [],
    });
  }
  return normalizeFacts(facts);
}
