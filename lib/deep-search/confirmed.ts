import {
  type NameParts,
  type SearchFacts,
  EMPTY_FACTS,
  mergeFacts,
  normalizeFacts,
  stateCode,
} from './facts.ts';
import { factsFromUrl, findDates } from './extract.ts';

/**
 * Human-confirmed truth: the mutations behind the confirm/unconfirm actions.
 *
 * Kept pure and separate from the route so the precedence and eviction rules can
 * be tested directly. Every function takes and returns a whole SearchFacts, so
 * callers read-modify-write the contact's confirmed_facts column without knowing
 * its shape.
 */

/** Only these may be confirmed — the keys SearchFacts actually carries. */
export const CONFIRMABLE_KEYS = Object.keys(EMPTY_FACTS) as (keyof SearchFacts)[];

export function isConfirmableKey(key: unknown): key is keyof SearchFacts {
  return typeof key === 'string' && (CONFIRMABLE_KEYS as string[]).includes(key);
}

/**
 * Coerce a human-typed value into the canonical form the engine compares
 * against — the same form the extractors emit. This is essential, not cosmetic:
 * the state-conflict check and probe-URL builder expect a two-letter code, and
 * date matching expects ISO, so a confirmed "nc" or "04/22/2026" that skipped
 * this would silently never match. normalizeFacts only dedupes; it does not
 * transform, so it cannot do this on its own.
 */
function canonicalValue(key: keyof SearchFacts, raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (key === 'state') return stateCode(trimmed);
  if (key === 'booking_dates') return findDates(trimmed)[0] ?? null;
  return trimmed;
}

/** Add one confirmed value, stored in the form the engine will match on. */
export function addConfirmedFact(
  existing: any,
  key: keyof SearchFacts,
  value: string
): SearchFacts {
  const canonical = canonicalValue(key, value);
  if (!canonical) return normalizeFacts(existing);
  return mergeFacts(normalizeFacts(existing), { [key]: [canonical] } as Partial<SearchFacts>);
}

/**
 * Remove one confirmed value. This is the eviction the old model lacked:
 * correcting a fact drops the wrong one instead of leaving it to keep steering
 * probes. Comparison is normalised on both sides so "nc" removes "NC".
 */
export function removeConfirmedFact(
  existing: any,
  key: keyof SearchFacts,
  value: string
): SearchFacts {
  const facts = normalizeFacts(existing);
  // Coerce the target the same way the stored value was, so "nc" removes "NC"
  // and "04/22/2026" removes the ISO form.
  const target = canonicalValue(key, value);
  if (target == null) return facts;
  return { ...facts, [key]: facts[key].filter((v) => v.toLowerCase() !== target.toLowerCase()) };
}

/**
 * Confirming a LINK converges on the same store: its value to the engine is the
 * facts its URL encodes (county, booking date, middle name, record id), so we
 * derive those and merge them in. The URL itself is recorded separately by the
 * caller as a confirmed candidate.
 */
export function confirmFactsFromUrl(
  existing: any,
  url: string,
  name: NameParts
): SearchFacts {
  return mergeFacts(normalizeFacts(existing), factsFromUrl(url, name));
}
