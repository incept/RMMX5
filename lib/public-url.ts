import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function privateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    /^127\./.test(normalized) ||
    /^10\./.test(normalized) ||
    /^192\.168\./.test(normalized) ||
    /^169\.254\./.test(normalized) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(normalized) ||
    /^0\./.test(normalized)
  );
}

export function parsePublicHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Provider URL must be a valid HTTPS URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port !== '' && url.port !== '443')
  ) {
    throw new Error('Provider URL must use HTTPS without embedded credentials or a custom port');
  }
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Provider URL must use a public hostname');
  }
  if (isIP(host) && privateAddress(host)) throw new Error('Private provider addresses are not allowed');
  return url;
}

export async function assertPublicHttpsUrl(value: string): Promise<URL> {
  const url = parsePublicHttpsUrl(value);
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
    throw new Error('Provider hostname resolved to a private or non-routable address');
  }
  return url;
}

export async function assertPublicWebUrl(value: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Probe URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Probe URL must be an HTTP(S) URL without credentials');
  }
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Probe URL must use a public hostname');
  }
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
    throw new Error('Probe hostname resolved to a private or non-routable address');
  }
  return url;
}
