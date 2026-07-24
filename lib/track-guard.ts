/**
 * Cheap defenses for the unauthenticated tracking endpoints. Every hit with a
 * plausible id costs several DB operations, so junk gets rejected before the
 * first query:
 *   * ids must be UUIDs — scanners probing ?m=../etc/passwd never reach the DB
 *   * a short per-id cooldown collapses bursts (mail-client prefetchers often
 *     fire the same pixel several times in a second)
 *
 * The cooldown is per-process memory. The host may run several app processes,
 * so it is best-effort — that's fine: correctness lives in the atomic
 * track_email_event RPC; this only sheds load.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTrackableId(id: string | null): id is string {
  return !!id && UUID_RE.test(id);
}

const COOLDOWN_MS = 10_000;
const MAX_ENTRIES = 5_000;
const lastSeen = new Map<string, number>();

/** True when this id hasn't been counted in the last 10s (and marks it now). */
export function passesCooldown(key: string, now = Date.now()): boolean {
  const prev = lastSeen.get(key);
  if (prev !== undefined && now - prev < COOLDOWN_MS) return false;

  // Bound the map: drop expired entries first, then oldest-inserted if a
  // burst of unique ids still overflows it.
  if (lastSeen.size >= MAX_ENTRIES) {
    for (const [k, t] of lastSeen) {
      if (now - t >= COOLDOWN_MS) lastSeen.delete(k);
    }
    while (lastSeen.size >= MAX_ENTRIES) {
      const oldest = lastSeen.keys().next().value;
      if (oldest === undefined) break;
      lastSeen.delete(oldest);
    }
  }

  lastSeen.set(key, now);
  return true;
}
