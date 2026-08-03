// SSRF guard for admin-supplied IMAP targets (finding #5). A full defense would
// resolve + pin, but as an admin-only feature the proportionate guard is to
// block the obvious internal destinations by literal (loopback, link-local,
// private ranges, cloud metadata) and restrict to the standard IMAP ports.

const PRIVATE_V4 = [
  /^127\./, // loopback
  /^10\./, // private
  /^192\.168\./, // private
  /^172\.(1[6-9]|2\d|3[01])\./, // private
  /^169\.254\./, // link-local / cloud metadata (169.254.169.254)
  /^0\./, // "this network"
];

/** Returns an error string if the host/port is disallowed, else null. */
export function validateImapTarget(host: string, port: number): string | null {
  const h = String(host ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (!h) return 'IMAP host is required';
  if (port !== 143 && port !== 993) return 'IMAP port must be 143 or 993';
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal')
  ) {
    return 'That IMAP host is not allowed';
  }
  if (PRIVATE_V4.some((re) => re.test(h))) return 'That IMAP host is not allowed';
  // IPv6 loopback (::1), link-local (fe80::/10), unique-local (fc00::/7).
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) {
    return 'That IMAP host is not allowed';
  }
  return null;
}
