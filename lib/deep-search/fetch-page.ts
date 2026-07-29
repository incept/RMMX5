// undici's own fetch, not the global one. Node's global fetch is built on its
// INTERNAL copy of undici and rejects a dispatcher created by the npm package
// with UND_ERR_INVALID_ARG, so the proxy tier has to go through undici's fetch
// for the dispatcher to be accepted at all.
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { fetchWithBrowser } from './browser.ts';
import { getSetting } from '@/lib/settings';
import { logDebug } from '@/lib/debug-log';
import { finishUsage, reserveUsage } from '@/lib/usage';
import { assertPublicWebUrl } from '@/lib/public-url';

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

/**
 * One coherent browser identity: Chrome on a 64-bit Windows laptop.
 *
 * Worth doing — plenty of these sites gate on a missing or non-browser UA, and
 * the previous value here sent "Chrome/124.0", a two-part version no real Chrome
 * has ever sent. But it is NOT sufficient on the strict hosts, and the reason is
 * worth recording so nobody re-runs this investigation:
 *
 * Against arrests.org (Cloudflare) from this machine, same IP, same headers:
 *   curl  -> HTTP 200 on roster, record and search.php (30/30)
 *   node  -> HTTP 403 Cloudflare 1020 on all three (6/6)
 *
 * The discriminator is the TLS handshake, not the headers. JA4 for curl here is
 * t13d2013h1_…, for Node t13d5212h1_… . Cloudflare fingerprints the handshake
 * (JA3/JA4) and Node's OpenSSL signature is refused. Node cannot fix this: the
 * `ciphers` and `ecdhCurve` options change a couple of JA3 fields but not the
 * extension list that dominates the hash, and every Chrome-shaped combination
 * tried still returned 1020. Matching a real browser needs a real browser's TLS
 * stack, which is why the browser tier exists — Chrome negotiates through
 * BoringSSL and is served normally. See ./browser.ts.
 *
 * Also worth knowing: the curl result came from the Windows Schannel stack, and
 * must not be read as "the site lets us in" generally. Hostinger is
 * Linux/OpenSSL, like Node, so curl there would be refused too.
 *
 * Keep the version current and change it in ONE place — a UA pinned to a Chrome
 * that is years stale is itself a signal.
 */
const CHROME_VERSION = '138';
const UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`;

/**
 * Sec-Fetch-Site: none and Sec-Fetch-User: ?1 describe a top-level navigation
 * the person started themselves (typed or bookmarked) rather than a subresource
 * or a click-through — which is exactly what a probe is, so no Referer is sent.
 *
 * Accept-Encoding is deliberately NOT set: undici negotiates it and transparently
 * decompresses. Setting it by hand can hand back raw compressed bytes, which the
 * parsers would read as an empty page — a silent wrong answer, the worst kind.
 */
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'sec-ch-ua': `"Google Chrome";v="${CHROME_VERSION}", "Chromium";v="${CHROME_VERSION}", "Not)A;Brand";v="99"`,
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

/**
 * Cloudflare challenges a small share of otherwise-fine requests: measured 3 of
 * 25 on pages that served on the very next try. One free retry converts most of
 * those, and it runs BEFORE the paid unlocker so a transient interstitial never
 * costs a billable call.
 */
const DIRECT_ATTEMPTS = 2;

/**
 * Optional proxy tier, between the free direct fetch and the paid unlocker.
 *
 * Some hosts drop the connection outright from a datacentre IP — mugshots.zone
 * and bustednewspaper.com both close the socket after the TLS handshake
 * completes (UND_ERR_SOCKET), which is 35.4% of historical client links between
 * them. That is an IP-reputation block, and unlike the arrests.org TLS-
 * fingerprint block it IS fixed by exiting from an ISP-classified address:
 * measured 200 with real search results through one, vs a dropped socket direct.
 *
 * Scoped per request via undici's ProxyAgent rather than HTTPS_PROXY, because
 * the env var is global — it would route Supabase and Stripe through a third
 * party too. Only probe fetches get the dispatcher.
 *
 * The tunnel is CONNECT with normal certificate validation, so TLS stays
 * end-to-end: the operator sees the hostname it is asked to connect to and
 * nothing else. A probe URL carries the client's name in its query string, and
 * that stays inside the encrypted stream. If a proxy ever requires disabling
 * certificate checks to work, it is reading the traffic — do not use it.
 */
let proxyAgentCache: { key: string; agent: ProxyAgent } | null = null;
let proxyIdleTimer: NodeJS.Timeout | null = null;

const MAX_PAGE_BYTES = 2 * 1024 * 1024;

function combinedSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([external, timeout]) : timeout;
}

async function readBoundedText(res: any, maxBytes = MAX_PAGE_BYTES): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Response exceeded ${maxBytes} bytes`);
  }
  if (!res.body) return '';

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeded ${maxBytes} bytes`);
      }
      out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function validateProxyEndpoint(hostValue: string, portValue: string | number) {
  const host = hostValue.trim().toLowerCase();
  const port = Number(portValue);
  if (
    !host ||
    host.includes('://') ||
    host.includes(':') ||
    /[\/\\@\s]/.test(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error('Proxy host or port is invalid');
  }
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '169.254.169.254' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host)
  ) {
    throw new Error('Private, loopback, and link-local proxy endpoints are not allowed');
  }
  return { host, port };
}

function touchProxyIdleTimer() {
  if (proxyIdleTimer) clearTimeout(proxyIdleTimer);
  proxyIdleTimer = setTimeout(() => {
    const cached = proxyAgentCache;
    proxyAgentCache = null;
    proxyIdleTimer = null;
    void cached?.agent.close().catch((error) =>
      logDebug({
        level: 'warn',
        source: 'deep-search:proxy',
        message: `Could not close idle proxy agent: ${error?.message ?? String(error)}`,
      }).catch(() => {})
    );
  }, 60_000);
  proxyIdleTimer.unref?.();
}

async function getProxyAgent(): Promise<{ agent: ProxyAgent; label: string } | null> {
  if (proxyIdleTimer) {
    clearTimeout(proxyIdleTimer);
    proxyIdleTimer = null;
  }
  const cfg = await getSetting<{
    host?: string;
    port?: string | number;
    username?: string;
    password?: string;
  }>('probe_proxy');
  if (!cfg.host || !cfg.port) return null;
  const endpoint = validateProxyEndpoint(cfg.host, cfg.port);

  const auth = cfg.username
    ? `${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.password ?? '')}@`
    : '';
  const url = `http://${auth}${endpoint.host}:${endpoint.port}`;
  // Agents pool connections, so rebuilding one per fetch would throw away every
  // established tunnel. Rebuild only when the configured endpoint changes.
  if (proxyAgentCache?.key !== url) {
    await proxyAgentCache?.agent.close().catch((error) =>
      logDebug({
        level: 'warn',
        source: 'deep-search:proxy',
        message: `Could not close replaced proxy agent: ${error?.message ?? String(error)}`,
      }).catch(() => {})
    );
    proxyAgentCache = { key: url, agent: new ProxyAgent(url) };
  }
  return { agent: proxyAgentCache.agent, label: `${endpoint.host}:${endpoint.port}` };
}

export type FetchOutcome =
  | { ok: true; html: string; via: 'direct' | 'proxy' | 'browser' | 'unlocker' }
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

/** A 200 transport response can still be an empty or synthetic error page. */
function pageFailure(status: number, html: string): string | null {
  if (status < 200 || status >= 300) return `HTTP ${status}`;
  const bodyText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!html.trim() || !bodyText) return `HTTP ${status} (empty body)`;
  if (looksBlocked(status, html)) return `HTTP ${status} (challenge page)`;

  const title =
    /<title\b[^>]*>([\s\S]*?)<\/title>/i
      .exec(html)?.[1]
      ?.replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() ?? '';
  const titleError =
    /^(?:(?:4|5)\d\d(?:\s*[-:|]\s*)?)?(?:error|not found|bad gateway|service unavailable|internal server error|gateway timeout|access denied)(?:\s*[-:|].*)?$/i;
  const bodyError =
    /^(?:(?:4|5)\d\d\s*(?:error|not found)\b|(?:error|page not found|bad gateway|service unavailable|internal server error|gateway timeout|upstream connect error|application error|this page (?:isn't|is not) working)\b)/i;
  if (titleError.test(title) || bodyError.test(bodyText.slice(0, 600))) {
    return `HTTP ${status} (error page)`;
  }
  return null;
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
  maxAttempts = 3,
  signal?: AbortSignal
): Promise<{ res: Response; body: string; attempts: number; debug: string | null }> {
  let last: { res: Response; body: string; debug: string | null } | null = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    // No custom headers or cookies are ever sent to the target — BrightData's
    // troubleshooting asks for default behaviour first, and this already is it.
    // debug is switched on from the second attempt so a failure that survives a
    // retry returns x-brd-debug (render / peer_country / destination_ip /
    // billed) instead of an opaque code.
    const res = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      signal: combinedSignal(60_000, signal),
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
    const body = await readBoundedText(res);
    const debug = res.headers.get('x-brd-debug');
    last = { res, body, debug };

    if (res.ok && body.trim()) return { res, body, attempts: attempt, debug };

    const failureSignal = [
      res.headers.get('x-brd-err-code'),
      res.headers.get('x-brd-err-msg'),
      body.slice(0, 300),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    if (POLICY_ERROR.test(failureSignal)) break; // settled, not retryable
    const transient = TRANSIENT_UNLOCKER_ERRORS.some((e) => failureSignal.includes(e));
    if (!transient || attempt === maxAttempts) break;
    await new Promise((r) => setTimeout(r, 1200 * attempt));
  }
  if (!last) throw new Error('Unlocker request did not start');
  return { ...last, attempts };
}

/**
 * One tier of the direct path: a browser-shaped GET, optionally through a
 * dispatcher. Retried once because Cloudflare challenges a small share of
 * otherwise-fine requests, and a free retry beats a billable unlocker call.
 */
async function browserFetch(
  url: string,
  via: 'direct' | 'proxy',
  dispatcher?: ProxyAgent,
  signal?: AbortSignal
): Promise<{ ok: true; html: string; via: 'direct' | 'proxy' } | { ok: false; note: string }> {
  let note = '';
  for (let attempt = 1; attempt <= DIRECT_ATTEMPTS; attempt++) {
    try {
      const res = dispatcher
        ? await undiciFetch(url, {
            redirect: 'manual',
            signal: combinedSignal(20_000, signal),
            headers: BROWSER_HEADERS,
            dispatcher,
          })
        : await fetch(url, {
            redirect: 'manual',
            signal: combinedSignal(20_000, signal),
            headers: BROWSER_HEADERS,
          });
      const html = await readBoundedText(res);
      const failure = pageFailure(res.status, html);
      if (res.ok && !failure) return { ok: true, html, via };
      note = `${via} ${failure ?? `HTTP ${res.status}`}`;
    } catch (e: any) {
      // undici reports a dropped socket as UND_ERR_SOCKET with a bare "fetch
      // failed" message, which says nothing on its own — keep the cause code.
      const cause = e?.cause?.code ?? e?.cause?.message;
      note = `${via} fetch failed: ${e?.message ?? 'unknown error'}${cause ? ` (${cause})` : ''}`;
    }
    // A challenge answered instantly is a bot tell, and at 3-15 leads a day
    // there is no reason to hurry.
    if (attempt < DIRECT_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
    }
  }
  return { ok: false, note: `${note} after ${DIRECT_ATTEMPTS} attempts` };
}

export async function fetchProbePage(
  url: string,
  opts?: { render?: boolean; needsBrowser?: boolean; signal?: AbortSignal }
): Promise<FetchOutcome> {
  const notes: string[] = [];
  await assertPublicWebUrl(url);

  // Hosts that fingerprint the TLS handshake refuse both HTTP tiers every time,
  // and each one costs two attempts on a 20s timeout. Skip straight to Chrome.
  if (!opts?.needsBrowser) {
    // Tier 1: plain fetch. Free, and nothing leaves our own connection.
    if (opts?.signal?.aborted) throw opts.signal.reason;
    const direct = await browserFetch(url, 'direct', undefined, opts?.signal);
    if (direct.ok) return direct;
    notes.push(direct.note);

    // Tier 2: the proxy, if one is configured. Still free per request and still
    // cheaper than the unlocker, but it does route the request through somebody
    // else, so it goes second.
    try {
      const proxy = await getProxyAgent();
      if (proxy) {
        const viaProxy = await browserFetch(url, 'proxy', proxy.agent, opts?.signal);
        touchProxyIdleTimer();
        if (viaProxy.ok) return viaProxy;
        notes.push(`${viaProxy.note} via ${proxy.label}`);
      }
    } catch (e: any) {
      // A misconfigured proxy must not take the unlocker path down with it.
      notes.push(`proxy tier unavailable: ${e?.message ?? 'unknown error'}`);
    }
  }

  // Tier 3: real Chrome. Costs CPU and memory rather than money, so it comes
  // before the billable unlocker — and it is the only tier that reaches a host
  // blocking us on the TLS fingerprint.
  const viaBrowser = await fetchWithBrowser(url, opts?.signal);
  const browserFailure = viaBrowser.ok
    ? pageFailure(viaBrowser.status, viaBrowser.html)
    : viaBrowser.reason;
  if (viaBrowser.ok && !browserFailure) {
    return { ok: true, html: viaBrowser.html, via: 'browser' };
  }
  notes.push(viaBrowser.ok ? `browser ${browserFailure}` : viaBrowser.reason);

  const directNote = notes.join('; ');

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
      !!opts?.render,
      3,
      opts?.signal
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

    const unlockerPageFailure = pageFailure(res.status, body);
    if (!res.ok || unlockerPageFailure) {
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
      await finishUsage(
        usage.id,
        'failed',
        `${unlockerPageFailure ?? `HTTP ${res.status}`}: ${detail}`
      );
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
        reason: `${directNote}; unlocker ${unlockerPageFailure ?? `HTTP ${res.status}`}: ${detail}`,
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
