import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  classifyProbeBrowser,
  isAlertableState,
  shouldAlertWorker,
  workerRecovered,
} from '../lib/browser-worker-status.ts';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const NOW = 1_700_000_000_000;
const SIX_HOURS = 6 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

test('classifyProbeBrowser separates disabled / unconfigured / no-secret / no-url from ok', () => {
  assert.equal(classifyProbeBrowser({ enabled: false }).reason, 'disabled');
  assert.equal(classifyProbeBrowser({ enabled: 'false', remote_url: 'https://w.example', remote_secret: 's' }).reason, 'disabled');
  assert.equal(classifyProbeBrowser({}).reason, 'unconfigured');
  assert.equal(classifyProbeBrowser({ remote_url: '', remote_secret: '' }).reason, 'unconfigured');
  assert.equal(classifyProbeBrowser({ remote_url: 'https://w.example', remote_secret: '  ' }).reason, 'no_secret');
  assert.equal(classifyProbeBrowser({ remote_secret: 'shh' }).reason, 'no_url');

  // Enabled blank/true does not disable; url + secret are trimmed.
  const ok = classifyProbeBrowser({ remote_url: '  https://w.example  ', remote_secret: '  s  ', enabled: 'true' });
  assert.deepEqual(ok, { ok: true, url: 'https://w.example', secret: 's' });
  assert.equal(classifyProbeBrowser({ remote_url: 'https://w.example', remote_secret: 's', enabled: true }).ok, true);
});

test('isAlertableState fires only for set-up-but-broken states', () => {
  for (const s of ['misconfigured', 'unreachable', 'unhealthy']) assert.equal(isAlertableState(s), true, s);
  for (const s of ['healthy', 'off']) assert.equal(isAlertableState(s), false, s);
});

test('shouldAlertWorker: new problem alerts, cooldown suppresses, elapsed re-alerts', () => {
  // Healthy / off never alert.
  assert.equal(shouldAlertWorker(null, 'healthy', NOW, SIX_HOURS), false);
  assert.equal(shouldAlertWorker(null, 'off', NOW, SIX_HOURS), false);
  // First time in a bad state alerts.
  assert.equal(shouldAlertWorker(null, 'unreachable', NOW, SIX_HOURS), true);
  // Changed kind of problem alerts.
  assert.equal(shouldAlertWorker({ state: 'unhealthy', last_alert_at: iso(NOW) }, 'unreachable', NOW, SIX_HOURS), true);
  // Same problem, within cooldown → quiet.
  assert.equal(shouldAlertWorker({ state: 'unreachable', last_alert_at: iso(NOW - 60_000) }, 'unreachable', NOW, SIX_HOURS), false);
  // Same problem, cooldown elapsed → re-alert.
  assert.equal(shouldAlertWorker({ state: 'unreachable', last_alert_at: iso(NOW - 7 * 60 * 60 * 1000) }, 'unreachable', NOW, SIX_HOURS), true);
  // Same problem but no recorded alert time → alert.
  assert.equal(shouldAlertWorker({ state: 'unreachable' }, 'unreachable', NOW, SIX_HOURS), true);
});

test('workerRecovered only when a previously-alertable worker is healthy again', () => {
  assert.equal(workerRecovered({ state: 'unreachable' }, 'healthy'), true);
  assert.equal(workerRecovered({ state: 'off' }, 'healthy'), false);
  assert.equal(workerRecovered(null, 'healthy'), false);
  assert.equal(workerRecovered({ state: 'unreachable' }, 'unreachable'), false);
});

test('browser.ts names the specific cause and exposes browserTierStatus', async () => {
  const src = await read('../lib/deep-search/browser.ts');
  assert.match(src, /export async function browserTierStatus/);
  assert.match(src, /classifyProbeBrowser/);
  // The old catch-all is gone; the message now carries the real reason.
  assert.doesNotMatch(src, /'no Chrome executable configured or found'/);
  assert.match(src, /no browser worker available/);
  assert.match(src, /\/healthz/);
});

test('the health monitor probes, tracks state, and emails admins', async () => {
  const src = await read('../lib/browser-worker-health.ts');
  assert.match(src, /browserTierStatus\(\)/);
  assert.match(src, /shouldAlertWorker/);
  assert.match(src, /browser_worker_health/); // state kept in settings, no migration
  assert.match(src, /sendViaEmailit/);
  assert.match(src, /\['admin', 'super_admin'\]/); // who gets alerted
});

test('the cron tick runs the browser-worker monitor', async () => {
  const tick = await read('../app/api/cron/tick/route.ts');
  assert.match(tick, /monitorBrowserWorker\(\)/);
  assert.match(tick, /'browser',/);
});
