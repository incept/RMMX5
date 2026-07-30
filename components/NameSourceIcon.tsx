/**
 * Marks a contact name that a machine supplied rather than a human — so an
 * operator sees at a glance that the name is a lead to verify, not confirmed
 * truth, and where it came from:
 *
 *   green  → CallScaler caller ID (the name the phone network handed us)
 *   yellow → Trestle reverse phone lookup (an admin-run number-to-name lookup)
 *
 * Both are phone-derived and can be wrong (stale CNAM, the account holder, a
 * business name). The marker is cleared the moment a human edits the name — see
 * the clear_name_source_on_rename trigger — so a corrected name shows nothing.
 *
 * A monochrome SVG on purpose: it inherits `currentColor`, which is what lets us
 * paint it green vs. yellow. A color emoji (📞) renders one fixed multi-color
 * glyph and cannot be recolored.
 */

// Heroicons v2 "phone" (solid, 20x20 viewBox).
const PHONE_PATH =
  'M2 3.5A1.5 1.5 0 013.5 2h1.148a1.5 1.5 0 011.465 1.175l.716 3.223a1.5 1.5 0 01-1.052 1.767l-.933.267c-.41.117-.643.555-.48.95a11.542 11.542 0 006.254 6.254c.395.163.833-.07.95-.48l.267-.933a1.5 1.5 0 011.767-1.052l3.223.716A1.5 1.5 0 0118 15.352V16.5a1.5 1.5 0 01-1.5 1.5H15c-1.149 0-2.263-.15-3.326-.43A13.022 13.022 0 012.43 8.326 13.019 13.019 0 012 5V3.5z';

const MARKERS = {
  callscaler: {
    color: 'text-green-600',
    label: 'Name from the CallScaler caller ID',
    title:
      'Name from the CallScaler caller ID — it may not be accurate. Editing it by hand clears this marker.',
  },
  reverse_lookup: {
    color: 'text-yellow-500',
    label: 'Name from a reverse phone lookup',
    title:
      'Name from a Trestle reverse phone lookup — it may not be accurate. Editing it by hand clears this marker.',
  },
} as const;

export function NameSourceIcon({
  source,
  className = 'h-3.5 w-3.5',
}: {
  source: string | null | undefined;
  className?: string;
}) {
  const marker = source ? MARKERS[source as keyof typeof MARKERS] : undefined;
  if (!marker) return null;
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className={`inline-block flex-none ${marker.color} ${className}`}
      role="img"
      aria-label={marker.label}
    >
      <title>{marker.title}</title>
      <path d={PHONE_PATH} />
    </svg>
  );
}
