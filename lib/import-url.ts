/**
 * Normalize a link cell from an import sheet to an HTTP(S) URL, or null when it
 * isn't one. A whole import used to 400 on the first messy link cell; instead
 * the route now normalizes what it can and skips the rest with a warning.
 *
 * Rules, from most to least forgiving:
 *   - a valid http(s) URL is kept as-is;
 *   - a scheme-less but host-like value (a dot, no whitespace) — the common
 *     case of a Monday link column or hand entry that dropped the scheme — is
 *     assumed https://;
 *   - anything else (another scheme like mailto:/tel:/ftp://, free text, a
 *     blank, an over-long value) returns null so the caller can skip it.
 *
 * Deliberately lightweight and synchronous: an import can carry thousands of
 * link cells, so there is no DNS/SSRF check here — the link checker validates a
 * URL for real (public host, not private) before it ever fetches one.
 */
export function normalizeImportUrl(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 2048) return null;

  // Already schemed: accept only a valid http(s) URL with a dotted hostname.
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      return url.hostname.includes('.') ? raw : null;
    } catch {
      return null;
    }
  }

  // A different explicit scheme (mailto:, tel:, ftp://, javascript:, data:, …).
  if (/^(mailto|tel|sms|ftp|ftps|file|javascript|data|geo|about|ws|wss):/i.test(raw)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null;

  // Scheme-less: only a host-like token is worth a guess.
  if (/\s/.test(raw) || !raw.includes('.')) return null;
  try {
    const url = new URL(`https://${raw}`);
    return url.hostname.includes('.') ? `https://${raw}` : null;
  } catch {
    return null;
  }
}
