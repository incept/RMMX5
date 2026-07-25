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
  'jr', 'sr', 'ii', 'iii', 'iv', 'unknown', 'none',
]);

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
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+County\b/g)) {
    const c = m[1].trim();
    if (c && !out.includes(c)) out.push(c);
  }
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
    const code = stateCode(segs[i]);
    if (code && /^[a-z][a-z-]+$/i.test(segs[i + 1])) {
      states.push(code);
      counties.push(titleCase(segs[i + 1].replace(/-/g, ' ')));
    }
  }
  // "northcarolina.arrests.org/Wake/2026/April/22/" — state as subdomain.
  const sub = host.split('.')[0];
  const subState = stateCode(sub);
  if (subState) {
    states.push(subState);
    if (segs[0] && /^[A-Za-z][A-Za-z-]+$/.test(segs[0])) counties.push(titleCase(segs[0]));
  }
  // "wakenc.mugshots.zone" — county and state fused into one subdomain label.
  const fused = /^([a-z]{3,})([a-z]{2})$/.exec(sub);
  if (fused && stateCode(fused[2])) {
    states.push(stateCode(fused[2])!);
    counties.push(titleCase(fused[1]));
  }

  if (states.length) facts.state = states;
  if (counties.length) facts.county = counties;

  const ids: string[] = [];
  for (const m of parsed.search.matchAll(/[?&]id=([\w-]{2,24})/gi)) ids.push(m[1]);
  for (const m of path.matchAll(/~([\w-]{2,24})/g)) ids.push(m[1]);
  if (ids.length) facts.record_ids = ids;

  const dates = findDates(path);
  if (dates.length) facts.booking_dates = dates;

  const middles = findMiddleNames(path.replace(/[-_]/g, ' '), name);
  if (middles.length) facts.middle = middles;

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
