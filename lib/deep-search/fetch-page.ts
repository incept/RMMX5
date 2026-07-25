import { getSetting } from '@/lib/settings';
import { logDebug } from '@/lib/debug-log';
import { finishUsage, reserveUsage } from '@/lib/usage';

/**
 * Page fetching for probes.
 *
 * These sites sit behind Cloudflare and similar, and a datacentre IP (which is
 * what shared hosting gives us) gets challenged often enough to matter. So:
 * try a plain fetch first — free, and it works on plenty of them — then fall
 * back to BrightData's unlocker if a zone is configured. A blocked probe is
 * reported, never silently treated as "no results found", because those two
 * outcomes mean completely different things to the operator.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export type FetchOutcome =
  | { ok: true; html: string; via: 'direct' | 'unlocker' }
  | { ok: false; reason: string; blocked: boolean };

/** Signatures of an interstitial rather than the page we asked for. */
function looksBlocked(status: number, html: string): boolean {
  if (status === 403 || status === 429 || status === 503) return true;
  const head = html.slice(0, 2000).toLowerCase();
  return (
    head.includes('just a moment') ||
    head.includes('cf-browser-verification') ||
    head.includes('checking your browser') ||
    head.includes('attention required') ||
    head.includes('captcha')
  );
}

export async function fetchProbePage(url: string): Promise<FetchOutcome> {
  let directNote = '';
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const html = await res.text();
    if (res.ok && !looksBlocked(res.status, html)) {
      return { ok: true, html, via: 'direct' };
    }
    directNote = `direct HTTP ${res.status}${looksBlocked(res.status, html) ? ' (challenge page)' : ''}`;
  } catch (e: any) {
    directNote = `direct fetch failed: ${e?.message ?? 'unknown error'}`;
  }

  // Unlocker fallback. Uses the same /request endpoint as the SERP integration
  // but a different zone, so it is opt-in: no zone configured means no attempt.
  const cfg = await getSetting<{
    api_key?: string;
    unlocker_zone?: string;
    unlocker_monthly_limit?: number | string;
  }>('brightdata');
  if (!cfg.api_key || !cfg.unlocker_zone) {
    return {
      ok: false,
      blocked: true,
      reason: `${directNote}; no BrightData unlocker_zone configured to retry through`,
    };
  }

  // Unlocker requests are billed, unlike the direct fetch above, so they are
  // metered the same way SERP requests are — otherwise probe spend would be
  // invisible. Reserving BEFORE the call is what lets the monthly limit stop
  // a runaway, and it records the attempt even if the process dies mid-request.
  const configuredLimit = Number(cfg.unlocker_monthly_limit);
  const usage = await reserveUsage({
    provider: 'brightdata',
    operation: 'unlocker',
    monthlyLimit:
      Number.isInteger(configuredLimit) && configuredLimit > 0 && configuredLimit <= 2_147_483_647
        ? configuredLimit
        : null,
    metadata: { zone: cfg.unlocker_zone, url: url.slice(0, 200) },
  });

  try {
    const res = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${cfg.api_key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ zone: cfg.unlocker_zone, url, format: 'raw' }),
    });
    const body = await res.text();
    if (!res.ok || !body.trim()) {
      await finishUsage(usage.id, 'failed', `HTTP ${res.status} ${body.slice(0, 160)}`);
      return {
        ok: false,
        blocked: true,
        reason: `${directNote}; unlocker HTTP ${res.status} ${body.slice(0, 160)}`,
      };
    }
    await finishUsage(usage.id, 'succeeded');
    return { ok: true, html: body, via: 'unlocker' };
  } catch (e: any) {
    await finishUsage(usage.id, 'failed', e?.message ?? 'unknown error');
    return {
      ok: false,
      blocked: true,
      reason: `${directNote}; unlocker failed: ${e?.message ?? 'unknown error'}`,
    };
  }
}

/**
 * Strips a page to the text and links an extractor needs. Keeps hrefs as
 * "[text](url)" so record links survive tag removal — the URL is the whole
 * point of a search-results page.
 */
export function stripToText(html: string, baseUrl: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');

  s = s.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      let abs = href;
      try {
        abs = new URL(href, baseUrl).toString();
      } catch {
        /* keep the raw href — the extractor can still read it */
      }
      return text ? ` [${text}](${abs}) ` : ` [](${abs}) `;
    }
  );

  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Absolute http(s) links found in stripped text, in document order. */
export function linksFromText(text: string): { text: string; url: string }[] {
  const out: { text: string; url: string }[] = [];
  const re = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ text: m[1].trim(), url: m[2] });
  return out;
}

export async function logProbeFailure(domain: string, url: string, reason: string, contactId: string) {
  await logDebug({
    level: 'warn',
    source: 'deep-search:probe',
    message: `Probe of ${domain} could not be read: ${reason}`,
    context: { url },
    contactId,
  });
}
