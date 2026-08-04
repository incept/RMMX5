/**
 * Parses a date cell from an import sheet into an ISO-8601 timestamp string, or
 * null when it's blank or unparseable (the import then falls back to now()).
 *
 * Numeric locale dates are accepted only when their month/day order is
 * unambiguous. For example 11/28/2024 is clearly US month/day, while 03/04/2024
 * is rejected rather than silently changing meaning between exports.
 */
export function parseImportDate(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  let normalized = raw;
  let expectedDate: { year: number; month: number; day: number } | null = null;
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (isoDate) {
    expectedDate = {
      year: Number(isoDate[1]),
      month: Number(isoDate[2]),
      day: Number(isoDate[3]),
    };
    normalized = `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}T00:00:00.000Z`;
  } else {
    const numeric = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/.exec(raw);
    if (numeric) {
      const first = Number(numeric[1]);
      const second = Number(numeric[2]);
      // Both <= 12 has two valid interpretations and needs an explicit locale.
      if (first <= 12 && second <= 12) return null;
      if (first > 12 || second > 31) return null;
      const month = first;
      const day = second;
      if (month > 12) return null; // DD/MM is not guessed silently.
      expectedDate = { year: Number(numeric[3]), month, day };
      normalized = `${numeric[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00.000Z`;
    } else if (!/[A-Za-z]|^\d{4}-\d{2}-\d{2}T/.test(raw)) {
      // Reject free-form numeric strings that Date.parse interprets differently
      // across runtimes. Named months and full ISO timestamps remain accepted.
      return null;
    }
  }

  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) return null;
  const parsed = new Date(ms);
  const year = parsed.getUTCFullYear();
  // Anything outside a generous window is almost certainly a mis-parse, not a
  // real lead date — drop it so the row keeps a sane (now) created_at.
  if (year < 1970 || year > 2100) return null;
  // Reject Date's overflow normalization (for example 2024-02-31 -> March).
  if (expectedDate) {
    if (
      parsed.getUTCFullYear() !== expectedDate.year ||
      parsed.getUTCMonth() + 1 !== expectedDate.month ||
      parsed.getUTCDate() !== expectedDate.day
    ) {
      return null;
    }
  }
  return parsed.toISOString();
}
