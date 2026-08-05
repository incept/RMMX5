/**
 * Pure helpers for the CallScaler tracking-number allowlist (Admin →
 * Integrations → CallScaler → "Only import calls to these numbers"). Kept free
 * of app imports so the matching logic is unit-testable in isolation; the DB and
 * settings wiring lives in lib/integrations/callscaler.ts.
 *
 * When the admin lists one or more tracking numbers, only calls that arrived on
 * one of those numbers are imported into the CRM — every other call is dropped
 * before it creates a contact. A blank list means "import all calls", which is
 * the unchanged default.
 */

/**
 * Reduces a phone value to its last 10 digits so numbers compare equal
 * regardless of formatting or a leading country code — "+1 (813) 421-8334",
 * "18134218334", and "813-421-8334" all become "8134218334". Returns null for
 * anything with fewer than 7 digits. Mirrors phoneDigits in
 * lib/integrations/callscaler.ts.
 */
export function normalizeCallNumber(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : null;
}

/**
 * Parses the admin's free-text list into a set of normalized numbers. Numbers
 * are separated by commas, semicolons, or newlines; formatting WITHIN a number
 * (spaces, dashes, parens, a leading +1) is preserved by normalizeCallNumber, so
 * "+1 813 421 8334" on its own line stays one number rather than four fragments.
 * A blank or all-junk input yields an empty set, which callers treat as
 * "no filter — import everything".
 */
export function parseAllowedNumbers(raw: string | null | undefined): Set<string> {
  const allowed = new Set<string>();
  for (const token of String(raw ?? '').split(/[,;\r\n]+/)) {
    const normalized = normalizeCallNumber(token);
    if (normalized) allowed.add(normalized);
  }
  return allowed;
}

/**
 * Whether a call that arrived on `trackingNumber` should be imported, given the
 * allowlist. An empty allowlist admits every call (the default); a non-empty one
 * admits only calls whose tracking number normalizes to a listed number.
 */
export function isTrackingNumberAllowed(
  trackingNumber: string | null | undefined,
  allowed: Set<string>
): boolean {
  if (allowed.size === 0) return true;
  const normalized = normalizeCallNumber(trackingNumber);
  return normalized != null && allowed.has(normalized);
}
