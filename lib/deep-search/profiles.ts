import {
  type NameParts,
  type SearchFacts,
  EMPTY_FACTS,
  mergeFacts,
} from './facts.ts';
import { factsFromUrl } from './extract.ts';

/**
 * Identity profiles: which PERSON does each candidate describe?
 *
 * A common name matches several real people — the review queue for one Gabriel
 * Lopez held a Florida identity (Collier and Lee counties, middle Alexander)
 * and an unrelated Arkansas one. Ungrouped, that reads as noise; grouped, it is
 * one decision: this one is them, that one is not.
 *
 * The state is the partition key because it is the fact these URLs encode most
 * reliably (subdomain, path segment, or fused county+state), and because two
 * same-named people in the SAME county are rare enough to leave to the per-link
 * review. Profiles are computed from the stored candidates at read time — no
 * second store to drift, and the choose/reject actions recompute the same
 * grouping server-side rather than trusting ids from the client.
 */

export interface CandidateLike {
  id: string | number;
  url: string;
  confidence?: number | string | null;
  matched_facts?: Record<string, unknown> | null;
}

export interface IdentityProfile {
  /** Two-letter state code, or 'unknown' for candidates with no state signal. */
  key: string;
  state: string | null;
  counties: string[];
  middles: string[];
  booking_dates: string[];
  record_ids: string[];
  candidate_ids: string[];
  link_count: number;
  top_confidence: number;
}

/** Everything a single candidate says about who its page is about. */
function candidateFacts(c: CandidateLike, name: NameParts): SearchFacts {
  let facts = mergeFacts({ ...EMPTY_FACTS }, factsFromUrl(String(c.url ?? ''), name));
  // scoreCorroboration stored the single value that matched at scoring time;
  // fold those in as variants. There is no state hint — the URL carries it.
  const m = (c.matched_facts ?? {}) as Record<string, unknown>;
  const hint = (key: keyof SearchFacts, value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      facts = mergeFacts(facts, { [key]: [value] } as Partial<SearchFacts>);
    }
  };
  hint('county', m.county);
  hint('middle', m.middle);
  hint('booking_dates', m.booking_date);
  hint('record_ids', m.record_id);
  return facts;
}

const sharesAValue = (a: string[], b: string[]) =>
  a.some((x) => b.some((y) => x.toLowerCase() === y.toLowerCase()));

export function profilesFor(candidates: CandidateLike[], name: NameParts): IdentityProfile[] {
  // Search views are tool links BUILT from the current fact pool; they carry no
  // independent evidence of identity, so they never join a profile.
  const enriched = candidates
    .filter((c) => (c.matched_facts as any)?.kind !== 'site_search')
    .map((c) => ({ c, facts: candidateFacts(c, name) }));

  type Group = { facts: SearchFacts; members: typeof enriched };
  const groups = new Map<string, Group>();
  const stateless: typeof enriched = [];

  // Pass 1: a candidate whose URL names a state anchors that state's profile.
  for (const e of enriched) {
    const st = e.facts.state[0] ?? null;
    if (!st) {
      stateless.push(e);
      continue;
    }
    const g = groups.get(st) ?? { facts: { ...EMPTY_FACTS }, members: [] };
    g.facts = mergeFacts(g.facts, e.facts);
    g.members.push(e);
    groups.set(st, g);
  }

  // Pass 2: a stateless candidate attaches only through SHARED EVIDENCE — its
  // record id or county appearing in exactly one profile. Matching two profiles
  // (or none) parks it in 'unknown' rather than guessing.
  const unplaced: typeof enriched = [];
  for (const e of stateless) {
    const matches = [...groups.values()].filter(
      (g) =>
        sharesAValue(e.facts.record_ids, g.facts.record_ids) ||
        sharesAValue(e.facts.county, g.facts.county)
    );
    if (matches.length === 1) {
      matches[0].facts = mergeFacts(matches[0].facts, e.facts);
      matches[0].members.push(e);
    } else {
      unplaced.push(e);
    }
  }

  const toProfile = (key: string, state: string | null, g: Group): IdentityProfile => ({
    key,
    state,
    counties: g.facts.county,
    middles: g.facts.middle,
    booking_dates: g.facts.booking_dates,
    record_ids: g.facts.record_ids,
    candidate_ids: g.members.map((m) => String(m.c.id)),
    link_count: g.members.length,
    top_confidence: Math.max(0, ...g.members.map((m) => Number(m.c.confidence) || 0)),
  });

  const out = [...groups.entries()].map(([st, g]) => toProfile(st, st, g));
  // Most evidence first — the likely-right person leads.
  out.sort(
    (a, b) =>
      b.link_count - a.link_count ||
      b.top_confidence - a.top_confidence ||
      a.key.localeCompare(b.key)
  );
  if (unplaced.length) {
    let facts: SearchFacts = { ...EMPTY_FACTS };
    for (const e of unplaced) facts = mergeFacts(facts, e.facts);
    out.push(toProfile('unknown', null, { facts, members: unplaced }));
  }
  return out;
}

/** True when the queue plausibly holds records of TWO different people. */
export function isAmbiguous(profiles: IdentityProfile[]): boolean {
  return profiles.filter((p) => p.state).length >= 2;
}
