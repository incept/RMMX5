import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { getSetting } from '@/lib/settings';
import { logDebug } from '@/lib/debug-log';

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
/** Chrome is only worth launching for pages we cannot get any cheaper way. */
const LAUNCH_TIMEOUT_MS = 30_000;

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
}[] = [];

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
    b = await pending;
    await b.close();
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
    const launching = puppeteer
      .launch({
        executablePath,
        headless: true,
        timeout: LAUNCH_TIMEOUT_MS,
        args: [
          // Most Linux hosts run the app as a user without the namespaces
          // Chrome's sandbox needs. Subresources are blocked and each fetch gets
          // its own incognito context, which is what limits exposure here.
          '--no-sandbox',
          '--disable-dev-shm-usage', // /dev/shm is tiny on shared hosts; without this Chrome crashes
          '--disable-blink-features=AutomationControlled',
          '--disable-extensions',
          '--disable-background-networking',
          '--no-first-run',
          '--mute-audio',
        ],
      })
      .catch((e) => {
        // A failed launch must not poison every later attempt.
        browserPromise = null;
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
async function acquireSlot(): Promise<void> {
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
        reject(new Error('Timed out waiting for a browser page slot'));
      }, SLOT_WAIT_MS),
    };
    waiter.timer.unref?.();
    waiters.push(waiter);
  });
  activePages += 1;
}

function releaseSlot(): void {
  activePages = Math.max(0, activePages - 1);
  const next = waiters.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve();
    return;
  }
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
    return { ok: false, unavailable: true, reason: 'no Chrome executable configured or found' };
  }

  let browser: Browser;
  try {
    browser = await getBrowser(executablePath);
  } catch (e: any) {
    return {
      ok: false,
      unavailable: true,
      reason: `Chrome failed to launch: ${e?.message ?? 'unknown error'}`,
    };
  }

  await acquireSlot();
  // An incognito context per fetch means no cookies or storage carry between
  // contacts, so one lead's session can never colour another's results.
  let context: Awaited<ReturnType<Browser['createBrowserContext']>> | null = null;
  let page: Page | null = null;
  const abortPage = () => {
    void page?.close().catch(() => {});
  };
  try {
    if (signal?.aborted) throw signal.reason ?? new Error('browser fetch cancelled');
    context = await browser.createBrowserContext();
    page = await context.newPage();
    if (signal?.aborted) throw signal.reason ?? new Error('browser fetch cancelled');
    signal?.addEventListener('abort', abortPage, { once: true });
    await page.setUserAgent(BROWSER_UA);
    await page.setViewport({ width: 1366, height: 768 });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'font', 'media', 'stylesheet'].includes(req.resourceType())) {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });

    const res = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT_MS,
    });
    const html = await page.content();
    return { ok: true, html, status: res?.status() ?? 0 };
  } catch (e: any) {
    return { ok: false, reason: `browser fetch failed: ${e?.message ?? 'unknown error'}` };
  } finally {
    signal?.removeEventListener('abort', abortPage);
    // Close the context, not just the page: an orphaned context keeps its own
    // renderer process alive, which is exactly the leak this tier must not add.
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    releaseSlot();
  }
}
