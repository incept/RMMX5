/**
 * True only for a real YYYY-MM-DD calendar date. A plain regex accepts
 * impossible dates (2026-02-31, 2026-99-99); those would reach PostgreSQL and
 * abort a mid-import chunk on the ::date cast, after earlier chunks committed.
 * No dependencies on purpose — safe to import from both API routes and the
 * node-tested parser.
 */
export function isValidISODate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}
