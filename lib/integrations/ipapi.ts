import { getSetting } from '@/lib/settings';
import { logDebug, errorMessage } from '@/lib/debug-log';

/**
 * ip-api.com geolocation (https://ip-api.com/docs).
 *
 * Leads arrive with an IP but often no city/state, which makes the automatic
 * Google search far too broad ("John Smith" with no location). Resolving the
 * IP gives the search a city/region to narrow on.
 *
 * Free tier is HTTP-only and rate-limited to ~45 requests/minute per source
 * IP; a paid key (Admin → Integrations → ip-api) switches to the HTTPS pro
 * endpoint with no such limit. Failures are non-fatal — the caller just
 * searches without a location.
 */
export interface IpLocation {
  city: string | null;
  region: string | null; // short code, e.g. "TX"
  regionName: string | null; // full name, e.g. "Texas"
  country: string | null;
}

/** Private/loopback/link-local ranges never resolve — skip the round trip. */
function isNonRoutable(ip: string): boolean {
  return (
    /^(10\.|127\.|0\.|169\.254\.|192\.168\.)/.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip === '::1' ||
    ip.startsWith('fc') ||
    ip.startsWith('fd')
  );
}

export async function lookupIpLocation(ip: string | null | undefined): Promise<IpLocation | null> {
  const trimmed = (ip ?? '').trim();
  if (!trimmed || isNonRoutable(trimmed)) return null;

  const cfg = await getSetting<{ api_key?: string }>('ipapi');
  const fields = 'status,message,country,region,regionName,city';
  const url = cfg.api_key
    ? `https://pro.ip-api.com/json/${encodeURIComponent(trimmed)}?key=${encodeURIComponent(cfg.api_key)}&fields=${fields}`
    : `http://ip-api.com/json/${encodeURIComponent(trimmed)}?fields=${fields}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      await logDebug({
        level: 'warn',
        source: 'ip-api',
        message: `Lookup failed: HTTP ${res.status}`,
        context: { ip: trimmed },
      });
      return null;
    }

    const data = await res.json();
    if (data.status !== 'success') {
      await logDebug({
        level: 'warn',
        source: 'ip-api',
        message: `Lookup rejected: ${data.message ?? 'unknown reason'}`,
        context: { ip: trimmed },
      });
      return null;
    }

    return {
      city: data.city || null,
      region: data.region || null,
      regionName: data.regionName || null,
      country: data.country || null,
    };
  } catch (e) {
    await logDebug({
      level: 'warn',
      source: 'ip-api',
      message: `Lookup error: ${errorMessage(e)}`,
      context: { ip: trimmed },
    });
    return null;
  }
}
