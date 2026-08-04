import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const IMAP_PORTS = new Set([143, 993]);
const SMTP_PORTS = new Set([25, 465, 587, 2525]);

function normalizeHost(host: string): string {
  return String(host ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

export function isPrivateMailAddress(address: string): boolean {
  let value = normalizeHost(address);
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);
  if (isIP(value) === 4) {
    const [a, b, c] = value.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (isIP(value) === 6) {
    const firstHextet = Number.parseInt(value.split(':', 1)[0] || '0', 16);
    return (
      value === '::' ||
      value === '::1' ||
      // Only 2000::/3 is globally routed unicast. Treat transition,
      // link-local, unique-local, multicast, and future/reserved space as
      // non-public rather than trying to enumerate every special range.
      (firstHextet & 0xe000) !== 0x2000 ||
      value.startsWith('2001:db8') || // documentation
      value.startsWith('2001:0:') || // Teredo / protocol assignments
      value.startsWith('2001:2:') || // benchmark testing
      /^2001:(1[0-9a-f]|2[0-9a-f]):/.test(value) || // ORCHID
      value.startsWith('2002:') // 6to4 transition addressing
    );
  }
  return false;
}

function validateHost(host: string): string | null {
  const normalized = normalizeHost(host);
  if (!normalized) return 'Mail host is required';
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.home')
  ) {
    return 'That mail host is not allowed';
  }
  if (isIP(normalized) && isPrivateMailAddress(normalized)) {
    return 'That mail host is not allowed';
  }
  if (!isIP(normalized) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized)) {
    return 'Mail host is invalid';
  }
  return null;
}

/** Fast validation for request payloads; the worker also resolves and pins DNS. */
export function validateImapTarget(host: string, port: number): string | null {
  const hostError = validateHost(host);
  if (hostError) return hostError.replace('Mail host', 'IMAP host').replace('mail host', 'IMAP host');
  if (!IMAP_PORTS.has(port)) return 'IMAP port must be 143 or 993';
  return null;
}

export function validateSmtpTarget(host: string, port: number): string | null {
  const hostError = validateHost(host);
  if (hostError) return hostError.replace('Mail host', 'SMTP host').replace('mail host', 'SMTP host');
  if (!SMTP_PORTS.has(port)) return 'SMTP port must be 25, 465, 587, or 2525';
  return null;
}

export type ResolvedMailTarget = {
  originalHost: string;
  address: string;
  servername?: string;
};

/**
 * Resolve every DNS answer, reject the target if any answer is non-public, and
 * return one address for the caller to connect to directly. Passing the original
 * hostname as TLS servername preserves certificate validation while preventing a
 * second, potentially rebound DNS lookup inside nodemailer/imapflow.
 */
export async function resolvePublicMailTarget(
  host: string,
  port: number,
  protocol: 'imap' | 'smtp'
): Promise<ResolvedMailTarget> {
  const validation =
    protocol === 'imap' ? validateImapTarget(host, port) : validateSmtpTarget(host, port);
  if (validation) throw new Error(validation);
  const originalHost = normalizeHost(host);
  const answers = isIP(originalHost)
    ? [{ address: originalHost }]
    : await lookup(originalHost, { all: true, verbatim: true });
  if (!answers.length) throw new Error(`${protocol.toUpperCase()} host did not resolve`);
  if (answers.some((answer) => isPrivateMailAddress(answer.address))) {
    throw new Error(`${protocol.toUpperCase()} host resolves to a private or reserved address`);
  }
  return {
    originalHost,
    address: answers[0].address,
    ...(isIP(originalHost) ? {} : { servername: originalHost }),
  };
}
