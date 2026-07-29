#!/usr/bin/env node
/**
 * RMMX5 browser worker.
 *
 * A tiny HTTP service that fetches one page with real Chrome and returns the
 * rendered HTML. It exists because the CRM's production host (shared/cloud
 * hosting) cannot run Chrome, while some record sites — arrests.org above all —
 * block every non-browser TLS fingerprint. Run this on any box that CAN run
 * Chrome (a small VPS), point the CRM's "Deep-search browser" settings at it,
 * and the browser tier works exactly as if Chrome were local.
 *
 * Deliberately dependency-light: Node's http module + puppeteer-core. No
 * Supabase credentials live here — the worker knows nothing about the CRM
 * except the shared secret, and it only ever fetches URLs the CRM sends it.
 *
 *   PORT            listen port (default 8787; bind stays on 127.0.0.1 — put
 *                   Caddy or nginx with HTTPS in front, never expose directly)
 *   HOST            listen host (default 127.0.0.1)
 *   WORKER_SECRET   required; the CRM must send it as a Bearer token
 *   CHROME_PATH     optional; auto-detects the usual locations otherwise
 *   CHROME_NO_SANDBOX=1  only if Chrome must run as root (prefer a normal user)
 *
 * Endpoints:
 *   GET  /healthz   → { ok, chrome } (no auth — safe: reveals only liveness)
 *   POST /fetch     → { url } → { ok, status, html } | { ok: false, reason }
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { access } from 'node:fs/promises';

// The UA override is what makes arrests.org work at all: headless Chrome's
// default UA says "HeadlessChrome" and is served a 403. Keep in step with
// BROWSER_UA in lib/deep-search/browser.ts.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/138.0.0.0 Safari/537.36';

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const SECRET = process.env.WORKER_SECRET || '';
const PAGE_TIMEOUT_MS = 45_000;
const MAX_CONCURRENT_PAGES = 2;
const MAX_QUEUED = 8;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 16 * 1024;

const DEFAULT_PATHS = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

if (!SECRET || SECRET.length < 24) {
  console.error(
    'WORKER_SECRET is required and must be at least 24 characters. Generate one with:\n' +
      "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  );
  process.exit(1);
}

async function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const p of DEFAULT_PATHS) {
    try {
      await access(p);
      return p;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/** Constant-time secret comparison; a plain === leaks length/prefix timing. */
function authorized(req) {
  const header = String(req.headers.authorization ?? '');
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(provided);
  const b = Buffer.from(SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The worker must never be usable as a proxy into its own network: only
 * public http(s) hosts are fetched. Literal private/loopback/link-local
 * addresses and localhost are refused outright.
 */
function isFetchableUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local')) {
    return false;
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (/^fe80:|^fc|^fd/i.test(host)) return false;
  return true;
}

let browserPromise = null;
let activePages = 0;
const waiters = [];

async function getBrowser(executablePath) {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { default: puppeteer } = await import('puppeteer-core');
      const args = [
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-extensions',
      ];
      if (process.env.CHROME_NO_SANDBOX === '1') {
        args.push('--no-sandbox', '--disable-setuid-sandbox');
      }
      const browser = await puppeteer.launch({ executablePath, headless: true, args });
      browser.on('disconnected', () => {
        browserPromise = null;
      });
      return browser;
    })();
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

function acquireSlot() {
  if (activePages < MAX_CONCURRENT_PAGES) {
    activePages += 1;
    return Promise.resolve();
  }
  if (waiters.length >= MAX_QUEUED) {
    return Promise.reject(new Error('worker is at capacity'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = waiters.indexOf(entry);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error('timed out waiting for a page slot'));
    }, 60_000);
    const entry = { resolve, timer };
    waiters.push(entry);
  });
}

function releaseSlot() {
  const next = waiters.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve();
  } else {
    activePages = Math.max(0, activePages - 1);
  }
}

async function fetchPage(url) {
  const executablePath = await resolveChrome();
  if (!executablePath) {
    return { ok: false, reason: 'no Chrome executable found on the worker host' };
  }
  await acquireSlot();
  let context = null;
  try {
    const browser = await getBrowser(executablePath);
    // An incognito context per fetch: no cookies or cache shared between
    // requests, and closing it reaps the renderer process.
    context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setUserAgent(BROWSER_UA);
    await page.setViewport({ width: 1366, height: 900 });
    // Documents and scripts render the page; images, media, and fonts only
    // spend the VPS's bandwidth.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (type === 'image' || type === 'media' || type === 'font') req.abort().catch(() => {});
      else req.continue().catch(() => {});
    });
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT_MS,
    });
    // Cloudflare interstitials resolve shortly after domcontentloaded; a small
    // settle window lets the challenge complete without waiting for networkidle
    // on pages that long-poll.
    await new Promise((r) => setTimeout(r, 2_500));
    const html = await page.content();
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
      return { ok: false, reason: `rendered HTML exceeds ${MAX_HTML_BYTES} bytes` };
    }
    return { ok: true, status: response?.status() ?? 200, html };
  } catch (e) {
    return { ok: false, reason: `browser fetch failed: ${e?.message ?? 'unknown error'}` };
  } finally {
    if (context) await context.close().catch(() => {});
    releaseSlot();
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      send(res, 200, { ok: true, chrome: (await resolveChrome()) !== null });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/fetch') {
      send(res, 404, { ok: false, reason: 'not found' });
      return;
    }
    if (!authorized(req)) {
      send(res, 401, { ok: false, reason: 'unauthorized' });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (e) {
      send(res, 400, { ok: false, reason: e?.message ?? 'invalid JSON' });
      return;
    }
    const url = typeof payload?.url === 'string' ? payload.url : '';
    if (!isFetchableUrl(url)) {
      send(res, 400, { ok: false, reason: 'url must be a public http(s) address' });
      return;
    }
    const result = await fetchPage(url);
    send(res, result.ok ? 200 : 502, result);
  } catch (e) {
    send(res, 500, { ok: false, reason: e?.message ?? 'internal error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`RMMX5 browser worker listening on ${HOST}:${PORT}`);
});
