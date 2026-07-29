// TYPE-ONLY, and it must stay that way. A static import put puppeteer-core in
// the module graph of everything that reaches deep search — including the queue,
// and therefore the route whose entire job is to INSERT ONE ROW. When the
// bundler then failed to materialise it on the host ("open EEXIST"), the whole
// chain died at load time, before any handler ran, so no try/catch could see it
// and nothing reached the debug log. An optional 300MB dependency must never be
// able to do that: the real import happens lazily, inside the one function that
// needs a browser, where failing means "this tier is unavailable" and no more.
import { type Browser, type Page } from 'puppeteer-core';
import { getSetting } from '@/lib/settings';
import { logDebug } from '@/lib/debug-log';
import { assertPublicWebUrl, parsePublicHttpsUrl } from '@/lib/public-url';
import { readResponseText } from '@/lib/request-limits';

/**
 * Headless Chrome, for the hosts that only a real browser can reach.
 *
 * arrests.org (20.5% of historical client links) refuses Node outright: its
 * Cloudflare rule reads the TLS handshake, and Node's OpenSSL signature (JA4
 * t13d5212h1, 52 cipher suites) is nothing like a browser's. No header, proxy,
 * or cipher option changes that — measured. Chrome negotiates through BoringSSL,
 * so it simply passes, and the daily county rosters come back as ordinary HTML.
 *
 * The one catch: Chrome's own headless User-Agent says "HeadlessChrome", which
 * Cloudflare blocks on sight. Overriding it is the whole difference between 403
 * and 200 — measured both ways, so BROWSER_UA is load-bearing, not decoration.
 *
 * Why this tier is worth its weight: it reads the site's own pages rather than a
 * search index, so it finds a booking the moment it is published instead of
 * whenever Google gets round to crawling it.
 *
 * RESOURCE DISCIPLINE. This host has already been taken down once by processes
 * that were started and never reaped, and a stray Chrome is far heavier than a
 * stray fetch. So:
 *   - exactly one browser process, shared by every caller;
 *   - it closes itself after IDLE_SHUTDOWN_MS with no work;
 *   - at most MAX_CONCURRENT_PAGES tabs at a time, queued rather than stacked;
 *   - every page is closed in a finally, including on timeout;
 *   - images, fonts, media and stylesheets are refused — we want the markup, and
 *     mugshot pages are mostly photographs.
 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/138.0.0.0 Safari/537.36';

const IDLE_SHUTDOWN_MS = 60_000;
const MAX_CONCURRENT_PAGES = 2;
const MAX_QUEUED_PAGES = 8;
const SLOT_WAIT_MS = 60_000;
const PAGE_TIMEOUT_MS = 45_000;
const MAX_RENDERED_HTML_BYTES = 2 * 1024 * 1024;
const MAX_DOM_NODES = 25_000;
/** Chrome is only worth launching for pages we cannot get any cheaper way. */
const LAUNCH_TIMEOUT_MS = 30_000;
/** Puppeteer control calls occasionally wedge after Chrome has already failed. */
const LIFECYCLE_TIMEOUT_MS = 10_000;
const RESOURCE_CLOSE_TIMEOUT_MS = 5_000;

/** Where Chrome usually lives, by platform. Overridden by the setting. */
const DEFAULT_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

let browserPromise: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let activePages = 0;
const waiters: {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}[] = [];

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error(signal?.aborted ? 'browser operation cancelled' : 'browser operation aborted');
}

/**
 * Bounds Puppeteer operations that do not accept an AbortSignal themselves.
 * `onLateResult` reaps resources created after the caller has already timed out
 * or been cancelled, so an abandoned createBrowserContext/newPage promise
 * cannot silently accumulate Chrome resources.
 */
function boundedOperation<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs: number,
  signal?: AbortSignal,
  onLateResult?: (value: T) => void | Promise<void>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(abortError(signal));
    const timer = setTimeout(
      () => fail(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    timer.unref?.();
    if (signal?.aborted) {
      fail(abortError(signal));
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }

    operation.then(
      (value) => {
        if (settled) {
          if (onLateResult) void Promise.resolve(onLateResult(value)).catch(() => {});
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

function looksLikeErrorDocument(title: string, bodyText: string): boolean {
  const normalizedTitle = title.replace(/\s+/g, ' ').trim();
  const normalizedBody = bodyText.replace(/\s+/g, ' ').trim().slice(0, 600);
  const titleError =
    /^(?:(?:4|5)\d\d(?:\s*[-:|]\s*)?)?(?:error|not found|bad gateway|service unavailable|internal server error|gateway timeout|access denied)(?:\s*[-:|].*)?$/i;
  const bodyError =
    /^(?:(?:4|5)\d\d\s*(?:error|not found)\b|(?:error|page not found|bad gateway|service unavailable|internal server error|gateway timeout|upstream connect error|application error|this page (?:isn't|is not) working)\b)/i;
  return titleError.test(normalizedTitle) || bodyError.test(normalizedBody);
}

async function resolveExecutable(): Promise<string | null> {
  const cfg = await getSetting<{ executable_path?: string; enabled?: string | boolean }>(
    'probe_browser'
  );
  // Explicitly off is different from unconfigured: an operator who has turned
  // this tier off should not have it silently launch anyway.
  if (cfg.enabled === false || cfg.enabled === 'false') return null;
  if (cfg.executable_path) return cfg.executable_path;

  const { access } = await import('node:fs/promises');
  for (const p of DEFAULT_PATHS) {
    try {
      await access(p);
      return p;
    } catch {
      // Not here; try the next one.
    }
  }
  return null;
}

/**
 * The remote browser worker (browser-worker/server.mjs on a VPS with Chrome).
 * Configured beside the local tier in the same probe_browser settings blob;
 * used only when no local executable exists, so a Chrome-capable host never
 * pays a network hop it doesn't need.
 */
async function resolveRemote(): Promise<{ url: URL; secret: string } | null> {
  const cfg = await getSetting<{
    enabled?: string | boolean;
    remote_url?: string;
    remote_secret?: string;
  }>('probe_browser');
  if (cfg.enabled === false || cfg.enabled === 'false') return null;
  const secret = cfg.remote_secret?.trim();
  if (!cfg.remote_url || !secret) return null;
  try {
    // HTTPS-only and public, enforced at save AND at use: probe URLs carry
    // client names and must never transit plaintext or point back into the
    // host's own network.
    return { url: parsePublicHttpsUrl(cfg.remote_url), secret };
  } catch {
    return null;
  }
}

const REMOTE_FETCH_TIMEOUT_MS = 60_000;

async function fetchWithRemoteBrowser(
  url: string,
  signal?: AbortSignal
): Promise<BrowserFetchResult> {
  const remote = await resolveRemote();
  if (!remote) {
    // Same wording the callers already key their logs on: this tier is not
    // set up here, neither locally nor remotely.
    return { ok: false, unavailable: true, reason: 'no Chrome executable configured or found' };
  }
  try {
    const signals = [AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS)];
    if (signal) signals.push(signal);
    const res = await fetch(new URL('/fetch', remote.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${remote.secret}`,
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.any(signals),
    });
    const bodyText = await readResponseText(res, MAX_RENDERED_HTML_BYTES + 64 * 1024);
    let data: any;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return { ok: false, reason: `remote browser returned non-JSON (HTTP ${res.status})` };
    }
    if (!res.ok || data?.ok !== true) {
      return {
        ok: false,
        reason: `remote browser: ${String(data?.reason ?? `HTTP ${res.status}`).slice(0, 300)}`,
      };
    }
    const html = typeof data.html === 'string' ? data.html : '';
    if (!html) return { ok: false, reason: 'remote browser returned an empty page' };
    if (Buffer.byteLength(html, 'utf8') > MAX_RENDERED_HTML_BYTES) {
      return { ok: false, reason: 'remote browser page exceeded the rendered-size cap' };
    }
    return { ok: true, html, status: Number.isInteger(data.status) ? data.status : 200 };
  } catch (e: any) {
    return { ok: false, reason: `remote browser fetch failed: ${e?.message ?? 'unknown error'}` };
  }
}

let availabilityCache: { value: boolean; at: number } | null = null;
const AVAILABILITY_TTL_MS = 60_000;

/**
 * Cheap, cached "could this tier run at all?" check. Callers that would skip
 * the free HTTP tiers on the promise of Chrome must ask this FIRST: on a host
 * with no Chrome (shared hosting), a browser-only fetch otherwise falls
 * straight through to the billable unlocker — which BrightData refuses by
 * policy for exactly the site that needs the browser. Cached briefly so a
 * settings change (enabling the tier, setting a path) still applies within a
 * minute without re-statting the filesystem on every URL.
 */
export async function browserAvailable(): Promise<boolean> {
  if (availabilityCache && Date.now() - availabilityCache.at < AVAILABILITY_TTL_MS) {
    return availabilityCache.value;
  }
  const value = (await resolveExecutable()) !== null || (await resolveRemote()) !== null;
  availabilityCache = { value, at: Date.now() };
  return value;
}

function touchIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void closeBrowser('idle');
  }, IDLE_SHUTDOWN_MS);
  // Do not hold the process open just to run a shutdown timer.
  idleTimer.unref?.();
}

export async function closeBrowser(reason: string): Promise<void> {
  if (reason === 'idle' && activePages > 0) return;
  const pending = browserPromise;
  browserPromise = null;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!pending) return;
  let b: Browser | null = null;
  try {
    b = await boundedOperation(
      pending,
      'waiting for browser startup before close',
      LAUNCH_TIMEOUT_MS,
      undefined,
      async (lateBrowser) => {
        // closeBrowser has already released the singleton slot. A launch that
        // resolves afterward must be reaped rather than becoming an orphan.
        try {
          await boundedOperation(
            lateBrowser.close(),
            'late browser close',
            RESOURCE_CLOSE_TIMEOUT_MS
          );
        } catch {
          lateBrowser.process()?.kill('SIGKILL');
        }
      }
    );
    await boundedOperation(b.close(), 'browser close', RESOURCE_CLOSE_TIMEOUT_MS);
    await logDebug({ source: 'deep-search:browser', message: `browser closed (${reason})` });
  } catch (error: any) {
    // close() occasionally fails while a renderer is wedged. Kill the owned
    // child as a last resort instead of leaving an orphaned Chromium tree.
    b?.process()?.kill('SIGKILL');
    await logDebug({
      level: 'warn',
      source: 'deep-search:browser',
      message: `Browser close failed (${reason}): ${error?.message ?? 'unknown error'}`,
    });
  }
}

async function getBrowser(executablePath: string): Promise<Browser> {
  if (!browserPromise) {
    // The import is loaded here, not at module scope, so a bundling or install
    // problem can only disable this tier — never break an unrelated route that
    // happens to sit downstream of the same import.
    //
    // Wrapped in an immediately-invoked async function so browserPromise is
    // claimed SYNCHRONOUSLY below: awaiting the import before assigning would
    // let two callers each pass the null check and launch their own Chrome,
    // which is the one thing this singleton exists to prevent.
    const launching = (async () => {
      const { default: puppeteer } = await import('puppeteer-core');
      return puppeteer.launch({
        executablePath,
        headless: true,
        timeout: LAUNCH_TIMEOUT_MS,
        args: [
          // TEMPORARY HOST COMPATIBILITY: remove these two flags after the
          // deployment environment's Chromium sandbox has been confirmed.
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage', // /dev/shm is tiny on shared hosts; without this Chrome crashes
          '--disable-blink-features=AutomationControlled',
          '--disable-extensions',
          '--disable-background-networking',
          '--no-first-run',
          '--mute-audio',
        ],
      });
    })().catch((e) => {
      // A failed launch — or a puppeteer-core that will not load at all — must
      // not poison every later attempt. Only clear the slot if it is still
      // OURS: closeBrowser during a pending launch nulls browserPromise, a
      // later call starts a second launch, and an unguarded clear here would
      // discard that live one and start a third, leaving two browser processes
      // running. Same guard as the 'disconnected' handler below.
      if (browserPromise === launching) browserPromise = null;
      throw e;
    });
    browserPromise = launching;
    void launching.then((browser) => {
      browser.once('disconnected', () => {
        if (browserPromise === launching) browserPromise = null;
      });
    });
  }
  return browserPromise;
}

/** Waits for a page slot so a burst of probes cannot open a tab each. */
async function acquireSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError(signal);
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (activePages < MAX_CONCURRENT_PAGES) {
    activePages += 1;
    return;
  }
  if (waiters.length >= MAX_QUEUED_PAGES) {
    throw new Error('Browser page queue is full; retry after the current search finishes');
  }
  await new Promise<void>((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        signal?.removeEventListener('abort', waiter.onAbort!);
        reject(new Error('Timed out waiting for a browser page slot'));
      }, SLOT_WAIT_MS),
      signal,
      onAbort: undefined as (() => void) | undefined,
    };
    waiter.onAbort = () => {
      const index = waiters.indexOf(waiter);
      if (index < 0) return;
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      signal?.removeEventListener('abort', waiter.onAbort!);
      reject(abortError(signal));
    };
    waiter.timer.unref?.();
    waiters.push(waiter);
    signal?.addEventListener('abort', waiter.onAbort, { once: true });
    // addEventListener does not replay an abort that happened between the
    // initial check and listener registration.
    if (signal?.aborted) waiter.onAbort();
  });
  // No increment here on purpose: releaseSlot hands its slot straight over, so
  // the count already includes this caller. See the note there.
}

function releaseSlot(): void {
  // Hand the slot to a waiter WITHOUT dropping the count in between. Releasing
  // first and letting the waiter re-take it left a gap: resolve() only queues
  // the waiter's continuation, so anything calling acquireSlot before that
  // microtask ran saw a free slot and took it, and both then proceeded —
  // MAX_CONCURRENT_PAGES of 2 was reachable at 3 with two runs overlapping.
  const next = waiters.shift();
  if (next) {
    clearTimeout(next.timer);
    next.signal?.removeEventListener('abort', next.onAbort!);
    next.resolve();
    return;
  }
  activePages = Math.max(0, activePages - 1);
  if (activePages === 0) touchIdleTimer();
}

export type BrowserFetchResult =
  | { ok: true; html: string; status: number }
  | { ok: false; reason: string; unavailable?: boolean };

/**
 * Fetches one page with real Chrome. `unavailable` distinguishes "this tier is
 * not set up" from "the tier ran and the page was blocked" — the caller needs
 * that difference to decide whether falling through to the unlocker is sensible.
 */
export async function fetchWithBrowser(
  url: string,
  signal?: AbortSignal
): Promise<BrowserFetchResult> {
  if (signal?.aborted) return { ok: false, reason: 'browser fetch cancelled' };
  const executablePath = await resolveExecutable();
  if (!executablePath) {
    // No local Chrome — hand the fetch to the remote worker if one is
    // configured. Same result shape, so callers cannot tell the difference,
    // and the unavailable outcome only remains when NEITHER exists.
    return fetchWithRemoteBrowser(url, signal);
  }

  let browser: Browser;
  try {
    browser = await getBrowser(executablePath);
  } catch (e: any) {
    return {
      ok: false,
      unavailable: true,
      // Covers a failed launch AND a puppeteer-core that will not load at all —
      // both mean the same thing to the caller: this tier cannot serve the
      // page, so fall through to the next rather than failing the run.
      reason: `Browser tier unavailable: ${e?.message ?? 'unknown error'}`,
    };
  }

  try {
    await acquireSlot(signal);
  } catch (error: any) {
    // Cancellation belongs to the job lease and must stop the whole fetch.
    // Capacity/time-limit failures only disable this tier, so the caller can
    // still fall through to the unlocker instead of losing the probe outright.
    if (signal?.aborted) throw signal.reason ?? error;
    return {
      ok: false,
      reason: `browser fetch failed: ${error?.message ?? 'could not acquire a page slot'}`,
    };
  }
  // An incognito context per fetch means no cookies or storage carry between
  // contacts, so one lead's session can never colour another's results.
  let context: Awaited<ReturnType<Browser['createBrowserContext']>> | null = null;
  let page: Page | null = null;
  let contextCloseFailed = false;
  const abortPage = () => {
    void page?.close().catch(() => {});
  };
  try {
    if (signal?.aborted) throw signal.reason ?? new Error('browser fetch cancelled');
    context = await boundedOperation(
      browser.createBrowserContext(),
      'creating browser context',
      LIFECYCLE_TIMEOUT_MS,
      signal,
      async (lateContext) => {
        try {
          await boundedOperation(
            lateContext.close(),
            'late browser context close',
            RESOURCE_CLOSE_TIMEOUT_MS
          );
        } catch {
          browser.process()?.kill('SIGKILL');
        }
      }
    );
    page = await boundedOperation(
      context.newPage(),
      'opening browser page',
      LIFECYCLE_TIMEOUT_MS,
      signal,
      async (latePage) => {
        try {
          await boundedOperation(
            latePage.close(),
            'late browser page close',
            RESOURCE_CLOSE_TIMEOUT_MS
          );
        } catch {
          browser.process()?.kill('SIGKILL');
        }
      }
    );
    if (signal?.aborted) throw signal.reason ?? new Error('browser fetch cancelled');
    signal?.addEventListener('abort', abortPage, { once: true });
    await boundedOperation(
      page.setUserAgent(BROWSER_UA),
      'configuring browser user agent',
      LIFECYCLE_TIMEOUT_MS,
      signal
    );
    await boundedOperation(
      page.setViewport({ width: 1366, height: 768 }),
      'configuring browser viewport',
      LIFECYCLE_TIMEOUT_MS,
      signal
    );

    await boundedOperation(
      page.setRequestInterception(true),
      'configuring browser request interception',
      LIFECYCLE_TIMEOUT_MS,
      signal
    );
    page.on('request', (req) => {
      void (async () => {
        try {
          if (req.isNavigationRequest()) await assertPublicWebUrl(req.url());
          if (['image', 'font', 'media', 'stylesheet'].includes(req.resourceType())) {
            await req.abort();
          } else {
            await req.continue();
          }
        } catch {
          await req.abort().catch(() => {});
        }
      })();
    });

    const res = await boundedOperation(
      page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_TIMEOUT_MS,
      }),
      'browser navigation',
      PAGE_TIMEOUT_MS + 5_000,
      signal
    );
    if (!res) throw new Error('browser navigation returned no HTTP response');
    const status = res.status();
    if (status < 200 || status >= 300) throw new Error(`browser HTTP ${status}`);
    const declaredLength = Number(res?.headers()['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RENDERED_HTML_BYTES) {
      throw new Error('browser response exceeded the 2 MB safety limit');
    }
    const size = await boundedOperation(
      page.evaluate(() => ({
        nodes: document.getElementsByTagName('*').length,
        htmlChars: document.documentElement?.outerHTML.length ?? 0,
        bodyText: document.body?.innerText ?? document.body?.textContent ?? '',
        title: document.title ?? '',
      })),
      'reading browser document metadata',
      LIFECYCLE_TIMEOUT_MS,
      signal
    );
    if (size.nodes > MAX_DOM_NODES || size.htmlChars > MAX_RENDERED_HTML_BYTES) {
      throw new Error(
        `rendered page exceeded safety limits (${size.nodes} nodes, ${size.htmlChars} characters)`
      );
    }
    const html = await boundedOperation(
      page.content(),
      'reading rendered browser HTML',
      LIFECYCLE_TIMEOUT_MS,
      signal
    );
    if (!size.bodyText.trim()) throw new Error('browser returned a blank page');
    if (looksLikeErrorDocument(size.title, size.bodyText)) {
      throw new Error('browser returned an error page with a successful HTTP status');
    }
    return { ok: true, html, status };
  } catch (e: any) {
    return { ok: false, reason: `browser fetch failed: ${e?.message ?? 'unknown error'}` };
  } finally {
    signal?.removeEventListener('abort', abortPage);
    // Close the context, not just the page: an orphaned context keeps its own
    // renderer process alive, which is exactly the leak this tier must not add.
    if (page) {
      await boundedOperation(
        page.close(),
        'browser page close',
        RESOURCE_CLOSE_TIMEOUT_MS
      ).catch(() => {});
    }
    if (context) {
      await boundedOperation(
        context.close(),
        'browser context close',
        RESOURCE_CLOSE_TIMEOUT_MS
      ).catch(() => {
        contextCloseFailed = true;
      });
    }
    if (contextCloseFailed) {
      // A context that cannot close can retain renderer processes forever.
      // Kill the exact owned browser; its disconnected handler releases the
      // singleton so a later probe can launch a clean replacement.
      browser.process()?.kill('SIGKILL');
      await logDebug({
        level: 'warn',
        source: 'deep-search:browser',
        message: 'Browser context cleanup timed out; killed Chromium to prevent a process leak',
      }).catch(() => {});
    }
    releaseSlot();
  }
}
