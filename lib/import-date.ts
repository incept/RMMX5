/**
 * Parses a date cell from an import sheet into an ISO-8601 timestamp string, or
 * null when it's blank or unparseable (the import then falls back to now()).
 *
 * Import sheets arrive in wildly different date formats — Monday.com exports as
 * locale strings ("11/28/2024"), CSVs carry whatever was typed, and ISO
 * ("2024-11-28") is common too. Date.parse handles all of these in V8; we only
 * add a sanity window so a mis-parse (e.g. a stray number read as a year 5000)
 * is rejected rather than stored as a garbage created_at.
 */
export function parseImportDate(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  const year = new Date(ms).getUTCFullYear();
  // Anything outside a generous window is almost certainly a mis-parse, not a
  // real lead date — drop it so the row keeps a sane (now) created_at.
  if (year < 1970 || year > 2100) return null;
  return new Date(ms).toISOString();
}
