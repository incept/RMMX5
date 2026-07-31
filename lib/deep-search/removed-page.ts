// Pure removal-page heuristics for the link re-check. Deliberately import-free
// (no '@/' aliases, no deps) so it can be unit-tested directly, and so the
// client-facing "is this record gone?" decision lives in one small, reviewable
// place. fetch-page.ts calls classifyLoadedPage for pages that return HTTP 200.

/**
 * Per-host "removed page" fingerprints. A site often keeps a placeholder at the
 * old URL after a takedown (HTTP 200, sometimes still echoing the person's
 * name), which the name check alone would read as still-live. Add an entry as a
 * site's takedown wording is confirmed — `removed` is matched against the page
 * title + text. Seeded empty on purpose: a guessed pattern is worse than none.
 *
 * Example (fill in real ones as sites are observed):
 *   { host: /(^|\.)somemugshotsite\.com$/i, removed: /record (?:has been )?removed/i },
 */
export const REMOVED_FINGERPRINTS: { host: RegExp; removed: RegExp }[] = [];

/**
 * Site-agnostic placeholder phrasing that broadly signals a taken-down record.
 * Kept conservative and anchored to record/profile/listing context so a live
 * arrest page ("removed from custody", a missing image) does not trip it — and
 * a false positive is only ever surfaced for one-click dismissal anyway.
 */
export const GENERIC_REMOVED_MARKERS =
  /(?:record|profile|listing|mugshot|arrest record|booking) (?:has been|was|is no longer|isn'?t)\s*(?:removed|deleted|taken down|available|online|listed)|record removed at the request|no longer in our (?:records|database|system)|this (?:record|profile|listing) (?:is )?no longer available|page (?:not found|no longer exists|has been removed)/i;

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** True when every >= 2-char token of the name appears as a whole word. */
export function pageMentionsName(text: string, name: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const parts = norm(name)
    .split(' ')
    .filter((p) => p.length >= 2);
  if (parts.length === 0) return true; // no name to look for — can't call it gone
  const haystack = ` ${norm(text)} `;
  return parts.every((p) => haystack.includes(` ${p} `));
}

/**
 * Classify a page that returned HTTP 200: is the client's record still up?
 *   1. a matching per-host removed fingerprint  -> gone (highest confidence)
 *   2. generic placeholder phrasing             -> gone
 *   3. the page still names the client          -> live
 *   4. otherwise                                -> gone
 * Fingerprints/markers win over the name check precisely so a "record removed"
 * placeholder that still echoes the name is caught.
 */
export function classifyLoadedPage(url: string, name: string, html: string): 'gone' | 'live' {
  const text = stripTags(html);
  const title = (/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/<[^>]+>/g, ' ');
  const probe = `${title} ${text}`.slice(0, 20_000);
  const host = hostOf(url);

  for (const fp of REMOVED_FINGERPRINTS) {
    if (fp.host.test(host) && fp.removed.test(probe)) return 'gone';
  }
  if (GENERIC_REMOVED_MARKERS.test(probe)) return 'gone';
  return pageMentionsName(text, name) ? 'live' : 'gone';
}
