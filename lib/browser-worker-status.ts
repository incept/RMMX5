/**
 * Pure classification + alert logic for the deep-search browser tier, kept free
 * of any DB/network/puppeteer imports so it is unit-testable on its own. The
 * async parts (DNS validation of the URL, the /healthz probe) live in
 * lib/deep-search/browser.ts; the settings read, email send, and cron wiring
 * live in lib/browser-worker-health.ts.
 */

export type BrowserTierState =
  // A usable tier exists: local Chrome, or a configured remote worker whose
  // /healthz reports Chrome present.
  | 'healthy'
  // Off by choice: the tier is disabled, or no remote worker is configured and
  // there is no local Chrome. Not alerted — nothing is expected to be running.
  | 'off'
  // Set up but broken config: the remote URL is present but the secret is blank,
  // or the URL fails validation (bad scheme, private/unresolvable host).
  | 'misconfigured'
  // Configured, but /healthz did not answer (worker/VPS down, DNS, TLS).
  | 'unreachable'
  // /healthz answered, but the worker reports no Chrome.
  | 'unhealthy';

export type ProbeBrowserConfig = {
  executable_path?: string;
  remote_url?: string;
  remote_secret?: string;
  enabled?: string | boolean;
};

export type RemoteClassification =
  | { ok: true; url: string; secret: string }
  | { ok: false; reason: 'disabled' | 'unconfigured' | 'no_secret' | 'no_url'; detail: string };

/**
 * Classify the remote-worker settings WITHOUT touching the network. Separating
 * this from the DNS check is what lets a caller tell "you never filled the
 * secret in" apart from "the box is down" — today both read as "not configured".
 */
export function classifyProbeBrowser(cfg: ProbeBrowserConfig): RemoteClassification {
  // Explicitly off is different from unconfigured: an operator who turned the
  // tier off should not be told it is broken.
  if (cfg.enabled === false || cfg.enabled === 'false') {
    return { ok: false, reason: 'disabled', detail: 'the browser tier is turned off (Enabled = false)' };
  }
  const url = typeof cfg.remote_url === 'string' ? cfg.remote_url.trim() : '';
  const secret = typeof cfg.remote_secret === 'string' ? cfg.remote_secret.trim() : '';
  if (!url && !secret) {
    return { ok: false, reason: 'unconfigured', detail: 'no remote worker URL or secret is set' };
  }
  if (url && !secret) {
    return {
      ok: false,
      reason: 'no_secret',
      detail:
        'the remote worker URL is set but its secret is blank — re-enter it in ' +
        'Admin → Integrations → "Deep-search browser (headless Chrome)"',
    };
  }
  if (!url && secret) {
    return { ok: false, reason: 'no_url', detail: 'the remote worker secret is set but the URL is blank' };
  }
  return { ok: true, url, secret };
}

/** Which states mean "set up but not working" — the ones worth an alert. */
export function isAlertableState(state: BrowserTierState): boolean {
  return state === 'misconfigured' || state === 'unreachable' || state === 'unhealthy';
}

export type WorkerHealthMemory = {
  state?: BrowserTierState;
  since?: string;
  last_alert_at?: string;
  last_check_at?: string;
};

/**
 * Alert on entering an alertable state (or its kind changing), then re-alert
 * while it persists only once the repeat window has elapsed — so a worker that
 * stays down does not email on every cron tick.
 */
export function shouldAlertWorker(
  prev: WorkerHealthMemory | null,
  state: BrowserTierState,
  nowMs: number,
  repeatMs: number
): boolean {
  if (!isAlertableState(state)) return false;
  if (!prev || prev.state !== state) return true; // a new problem, or a different kind
  const last = prev.last_alert_at ? Date.parse(prev.last_alert_at) : NaN;
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= repeatMs; // still broken and the cooldown has passed
}

/** True when a previously-alertable worker is now healthy (send a recovery note). */
export function workerRecovered(prev: WorkerHealthMemory | null, state: BrowserTierState): boolean {
  return state === 'healthy' && !!prev && isAlertableState(prev.state as BrowserTierState);
}
