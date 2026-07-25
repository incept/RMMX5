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
  // policyBlocked means BrightData will refuse this host every time, which the
  // caller uses to stop spending unlocker calls on it.
  | { ok: false; reason: string; blocked: boolean; policyBlocked?: boolean };

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

/** BrightData failure classes we can distinguish from the response. */
const TRANSIENT_UNLOCKER_ERRORS = [
  'err_http2_protocol_error', // seen repeatedly on bustednewspaper.com, and it
  'before_session_error',     // succeeds on a later attempt
  'proxy_error',
];
/**
 * A policy refusal: BrightData classifies the target and declines it, so no
 * retry, zone change, or header tweak helps. Documented shape:
 *   policy_20000: "Access denied: <URL> is classified as <category> and blocked
 *   by Bright Data"
 */
const POLICY_ERROR =
  /policy_\d+|classified as .*blocked|blocked by bright ?data|policy restriction|not supported/i;

/**
 * One unlocker request, retried only for errors that are actually transient.
 *
 * Account logs for bustednewspaper.com show ERR_HTTP2_PROTOCOL_ERROR and
 * before_session_error interleaved with successful GETs on the same host, so a
 * single attempt understates what the zone can do. Policy refusals are the
 * opposite: arrests.org returns policy_20000 every time, and retrying it just
 * burns time on a decision BrightData has already made.
 */
async function unlockerRequest(
  apiKey: string,
  zone: string,
  url: string,
  render: boolean,
  maxAttempts = 3
): Promise<{ res: Response; body: string; attempts: number; debug: string | null }> {
  let last: { res: Response; body: string; debug: string | null } | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // No custom headers or cookies are ever sent to the target — BrightData's
    // troubleshooting asks for default behaviour first, and this already is it.
    // debug is switched on from the second attempt so a failure that survives a
    // retry returns x-brd-debug (render / peer_country / destination_ip /
    // billed) instead of an opaque code.
    const res = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        zone,
        url,
        format: 'raw',
        ...(render ? { render: true } : {}),
        ...(attempt > 1 ? { debug: true } : {}),
      }),
    });
    const body = await res.text();
    const debug = res.headers.get('x-brd-debug');
    last = { res, body, debug };

    if (res.ok && body.trim()) return { res, body, attempts: attempt, debug };

    const signal = [
      res.headers.get('x-brd-err-code'),
      res.headers.get('x-brd-err-msg'),
      body.slice(0, 300),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    if (POLICY_ERROR.test(signal)) break; // settled, not retryable
    const transient = TRANSIENT_UNLOCKER_ERRORS.some((e) => signal.includes(e));
    if (!transient || attempt === maxAttempts) break;
    await new Promise((r) => setTimeout(r, 1200 * attempt));
  }
  return { ...last!, attempts: maxAttempts };
}

export async function fetchProbePage(
  url: string,
  opts?: { render?: boolean }
): Promise<FetchOutcome> {
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

  // Metered like SERP requests, otherwise probe spend would be invisible.
  // BrightData bills successful requests only, so a failed attempt is recorded
  // for health but priced at nothing. Reserving BEFORE the call is what lets the
  // monthly cap stop a runaway and records an attempt that never came back.
  //
  // NOTE: social networks are explicitly outside Web Unlocker's supported use
  // cases (Facebook, Instagram, X, Reddit and friends), so those domains must
  // never be added as probe sites. Social coverage comes from the SERP
  // classifier instead.
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
    const { res, body, attempts, debug } = await unlockerRequest(
      cfg.api_key,
      cfg.unlocker_zone,
      url,
      !!opts?.render
    );
    if (attempts > 1) {
      await logDebug({
        level: 'info',
        source: 'deep-search:probe',
        message: `Unlocker needed ${attempts} attempts for ${new URL(url).hostname}`,
        context: { url },
      });
    }

    // BrightData reports zone and target problems in x-brd-* headers, and a
    // wrong zone TYPE comes back as a 200 with an empty body — which read as an
    // unexplained "unlocker HTTP 200" until these were surfaced.
    const brdError = [res.headers.get('x-brd-err-code'), res.headers.get('x-brd-err-msg')]
      .filter(Boolean)
      .join(' ');

    if (!res.ok || !body.trim()) {
      const signal = `${brdError} ${body.slice(0, 300)}`.toLowerCase();
      const detail = POLICY_ERROR.test(signal)
        ? `BrightData refused this target by policy (${brdError || 'policy error'}). ` +
          'Retrying cannot help: ask their compliance team to allow the domain for ' +
          'your account, or rely on the site: SERP fallback, which reaches the same ' +
          'records through Google.'
        : brdError ||
          (body.trim()
            ? body.slice(0, 160)
            : `empty body — confirm "${cfg.unlocker_zone}" is a WEB UNLOCKER zone (a SERP or plain proxy zone returns nothing here) and is active`);
      const policyBlocked = POLICY_ERROR.test(signal);
      await finishUsage(usage.id, 'failed', `HTTP ${res.status} ${detail}`);
      if (debug) {
        await logDebug({
          level: 'info',
          source: 'deep-search:probe',
          message: `BrightData debug for ${new URL(url).hostname}: ${debug.slice(0, 500)}`,
          context: { url },
        });
      }
      return {
        ok: false,
        blocked: true,
        policyBlocked,
        reason: `${directNote}; unlocker HTTP ${res.status}: ${detail}`,
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
