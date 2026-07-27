/**
 * The fact model behind deep search.
 *
 * Every fact is a SET of variants, never a single value, because sources
 * disagree: for one real arrest, wakencbusts spells the middle name "Micheal"
 * and mugshots.zone spells it "Michael". Collapsing to one spelling loses half
 * the search space, so both are kept and both get searched.
 */

export interface SearchFacts {
  middle: string[];
  county: string[];
  state: string[]; // two-letter codes, uppercased
  booking_dates: string[]; // ISO yyyy-mm-dd
  record_ids: string[];
  charges: string[];
  aliases: string[];
}

export const EMPTY_FACTS: SearchFacts = {
  middle: [], county: [], state: [], booking_dates: [], record_ids: [], charges: [], aliases: [],
};

const FACT_KEYS = Object.keys(EMPTY_FACTS) as (keyof SearchFacts)[];
/** Per-key caps so a pathological page can't grow the blob without bound. */
const MAX_PER_KEY = 12;

export function normalizeFacts(raw: any): SearchFacts {
  const out: SearchFacts = { ...EMPTY_FACTS };
  for (const key of FACT_KEYS) {
    const list = Array.isArray(raw?.[key]) ? raw[key] : [];
    out[key] = dedupeStrings(list).slice(0, MAX_PER_KEY);
  }
  return out;
}

/** Case-insensitive dedupe that keeps the first spelling seen. */
function dedupeStrings(values: any[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const s = String(v ?? '').trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export function mergeFacts(base: SearchFacts, incoming: Partial<SearchFacts>): SearchFacts {
  const out = { ...base };
  for (const key of FACT_KEYS) {
    out[key] = dedupeStrings([...(base[key] ?? []), ...(incoming[key] ?? [])]).slice(0, MAX_PER_KEY);
  }
  return out;
}

export function factsAreEqual(a: SearchFacts, b: SearchFacts): boolean {
  return FACT_KEYS.every(
    (k) => a[k].length === b[k].length && a[k].every((v, i) => v === b[k][i])
  );
}

/** "Wake County" / "wake" → "wake" — the form that appears in URLs and slugs. */
export function countySlug(county: string): string {
  return county
    .toLowerCase()
    .replace(/\bcounty\b/g, '')
    .trim()
    .replace(/[^a-z0-9]+/g, '');
}

const STATE_NAMES: Record<string, string> = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california',
  CO: 'colorado', CT: 'connecticut', DE: 'delaware', DC: 'districtofcolumbia',
  FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois',
  IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana',
  ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan',
  MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana',
  NE: 'nebraska', NV: 'nevada', NH: 'newhampshire', NJ: 'newjersey',
  NM: 'newmexico', NY: 'newyork', NC: 'northcarolina', ND: 'northdakota',
  OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania',
  RI: 'rhodeisland', SC: 'southcarolina', SD: 'southdakota', TN: 'tennessee',
  TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington',
  WV: 'westvirginia', WI: 'wisconsin', WY: 'wyoming',
};
const NAME_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_NAMES).map(([code, name]) => [name, code])
);

/** Accepts "NC", "nc", "North Carolina" → "NC". Returns null if unrecognised. */
export function stateCode(value: string | null | undefined): string | null {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const upper = s.toUpperCase();
  if (STATE_NAMES[upper]) return upper;
  const squashed = s.toLowerCase().replace(/[^a-z]/g, '');
  return NAME_TO_CODE[squashed] ?? null;
}

/** "NC" → "northcarolina", the form used in arrests.org-style subdomains. */
export function stateName(code: string): string {
  return STATE_NAMES[code.toUpperCase()] ?? code.toLowerCase();
}

export interface NameParts {
  first: string;
  last: string;
  middle: string;
}

/** Splits a stored contact name. Middle is whatever sits between first and last. */
export function splitName(fullName: string): NameParts {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '', middle: '' };
  if (parts.length === 1) return { first: parts[0], last: '', middle: '' };
  return {
    first: parts[0],
    last: parts[parts.length - 1],
    middle: parts.slice(1, -1).join(' '),
  };
}

/**
 * How much a found page corroborates being THIS person, 0..1.
 *
 * The surname is mandatory: without it the record belongs to someone else, no
 * matter how many other words line up. Everything above the floor comes from
 * independent facts agreeing — which is why "John Smith" needs a county or a
 * booking date before it counts, while a rare surname clears on the name alone.
 */
export function scoreCorroboration(
  haystack: string,
  name: NameParts,
  facts: SearchFacts
): { confidence: number; matched: Record<string, string> } {
  const text = haystack.toLowerCase();
  const matched: Record<string, string> = {};

  const last = name.last.toLowerCase();
  if (!last || !text.includes(last)) return { confidence: 0, matched };
  matched.last = name.last;

  let score = 0.4; // surname only — never enough on its own for a common name
  if (name.first && text.includes(name.first.toLowerCase())) {
    matched.first = name.first;
    score += 0.15;
  }

  const hit = (values: string[], transform: (v: string) => string = (v) => v) =>
    values.find((v) => v && text.includes(transform(v).toLowerCase()));

  const county = hit(facts.county, (c) => countySlug(c) || c);
  if (county) {
    matched.county = county;
    score += 0.2;
  }
  const middle = hit(facts.middle);
  if (middle) {
    matched.middle = middle;
    score += 0.15;
  }
  const recordId = hit(facts.record_ids);
  if (recordId) {
    matched.record_id = recordId;
    score += 0.2; // a shared record id across sibling sites is strong evidence
  }
  const date = facts.booking_dates.find((d) => dateVariants(d).some((v) => text.includes(v)));
  if (date) {
    matched.booking_date = date;
    score += 0.15;
  }

  return { confidence: Math.min(1, Math.round(score * 100) / 100), matched };
}

/** "2026-04-22" → the spellings booking sites actually use in titles and URLs. */
export function dateVariants(iso: string): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return [iso.toLowerCase()];
  const [, y, mo, d] = m;
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const monthName = months[Number(mo) - 1] ?? '';
  return [
    `${mo}/${d}/${y}`,
    `${mo}-${d}-${y}`,
    `${y}-${mo}-${d}`,
    `${y}/${mo}/${d}`,
    `${monthName} ${Number(d)}, ${y}`,
    `${monthName}/${d}`,
  ].filter(Boolean);
}

/**
 * The FromDate/ToDate window some site searches require (recentlybooked wants
 * one).
 *
 * Called with NO dates — every ordinary run — it is a rolling window: today
 * back seven years, computed fresh each run. Known booking dates deliberately
 * do not narrow it: a window bracketing known dates excluded both newer and
 * older arrests from the very site search that had them (a fresh July 23
 * record sat invisible behind a window built from older dates).
 *
 * Called WITH dates — a run focused on one arrest — the window hugs those
 * dates, padded a week either side because sites disagree on arrest vs
 * booking vs publish date. Digging into one booking is the one time narrow
 * is right.
 */
export function dateWindow(dates: string[], today = new Date()): { from: string; to: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const valid = dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!valid.length) {
    const from = new Date(today);
    from.setFullYear(from.getFullYear() - 7);
    return { from: iso(from), to: iso(today) };
  }
  const pad = (d: string, days: number) => {
    const dt = new Date(`${d}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + days);
    return iso(dt);
  };
  return { from: pad(valid[0], -7), to: pad(valid[valid.length - 1], 7) };
}
