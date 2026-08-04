import { createAdminClient } from '@/lib/supabase/server';
import { getSetting, setSetting } from '@/lib/settings';
import { browserTierStatus } from '@/lib/deep-search/browser';
import { sendViaEmailit } from '@/lib/integrations/emailit';
import { logDebug } from '@/lib/debug-log';
import {
  isAlertableState,
  shouldAlertWorker,
  workerRecovered,
  type BrowserTierState,
  type WorkerHealthMemory,
} from '@/lib/browser-worker-status';

const HEALTH_SETTING = 'browser_worker_health';
const CHECK_INTERVAL_MS = 5 * 60_000; // probe the worker at most ~every 5 minutes
const ALERT_REPEAT_MS = 6 * 60 * 60_000; // re-alert at most every 6h while still down
const MAX_ALERT_RECIPIENTS = 10;

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Active admins/super-admins with an email on file — who gets the alert. */
async function alertRecipients(): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('profiles')
    .select('email')
    .in('role', ['admin', 'super_admin'])
    .eq('status', 'active')
    .not('email', 'is', null)
    .limit(MAX_ALERT_RECIPIENTS);
  return [
    ...new Set(
      (data ?? []).map((r) => (r as { email?: string }).email).filter(Boolean) as string[]
    ),
  ];
}

async function emailAdmins(subject: string, lines: string[], keySuffix: string): Promise<void> {
  const recipients = await alertRecipients();
  if (!recipients.length) return;
  const html = `<p>${esc(lines.join('\n')).replaceAll('\n', '<br/>')}</p>`;
  // Same hour bucket → one email per recipient even if the tick retries.
  const hourBucket = new Date().toISOString().slice(0, 13);
  for (const to of recipients) {
    await sendViaEmailit({
      to,
      subject,
      html,
      idempotencyKey: `browser-worker:${keySuffix}:${hourBucket}:${to}`,
    }).catch(() => {});
  }
}

/**
 * Cron health check for the deep-search browser worker (the VPS Chrome service).
 *
 * Why this exists: when the worker is down or misconfigured, arrests.org and
 * other browser-only sites can't be read, and client link re-checks silently
 * return "unknown" — visible before only as accumulating debug-log noise. This
 * turns that into an active email alert.
 *
 * Throttled to one probe per CHECK_INTERVAL_MS; alerts only for a set-up-but-
 * broken tier (misconfigured / unreachable / unhealthy), with a cooldown so a
 * persistent outage doesn't email every tick; sends a one-off recovery note.
 * State lives in the settings table, so there is no migration.
 */
export async function monitorBrowserWorker(nowMs = Date.now()): Promise<{
  state: BrowserTierState;
  checked: boolean;
  alerted: boolean;
}> {
  const prev = await getSetting<WorkerHealthMemory>(HEALTH_SETTING, { fresh: true });
  const lastCheck = prev.last_check_at ? Date.parse(prev.last_check_at) : NaN;
  if (Number.isFinite(lastCheck) && nowMs - lastCheck < CHECK_INTERVAL_MS) {
    return { state: (prev.state as BrowserTierState) ?? 'healthy', checked: false, alerted: false };
  }

  const status = await browserTierStatus();
  const nowIso = new Date(nowMs).toISOString();
  const alert = shouldAlertWorker(prev, status.state, nowMs, ALERT_REPEAT_MS);
  const recovered = workerRecovered(prev, status.state);

  const next: WorkerHealthMemory = {
    state: status.state,
    since: prev.state === status.state && prev.since ? prev.since : nowIso,
    last_alert_at: alert ? nowIso : prev.last_alert_at,
    last_check_at: nowIso,
  };
  await setSetting(HEALTH_SETTING, next);

  if (alert) {
    await logDebug({
      level: 'error',
      source: 'browser-worker',
      message: `Browser worker ${status.state}: ${status.detail}`,
    }).catch(() => {});
    await emailAdmins(
      `RMMX5: deep-search browser worker ${status.state}`,
      [
        'The deep-search browser worker is not usable right now, so arrests.org and other',
        'browser-only record sites cannot be read — client link re-checks on those sites',
        'return "unknown" and cannot confirm a removal.',
        '',
        `State: ${status.state}`,
        `Detail: ${status.detail}`,
        '',
        'Check Admin → Integrations → "Deep-search browser (headless Chrome)" and the VPS worker',
        '(curl https://<worker-domain>/healthz should return {"ok":true,"chrome":true}).',
      ],
      status.state
    ).catch(() => {});
  } else if (recovered) {
    await logDebug({
      level: 'info',
      source: 'browser-worker',
      message: `Browser worker recovered: ${status.detail}`,
    }).catch(() => {});
    await emailAdmins(
      'RMMX5: deep-search browser worker recovered',
      ['The deep-search browser worker is healthy again.', '', `Detail: ${status.detail}`],
      'recovered'
    ).catch(() => {});
  } else if (isAlertableState(status.state)) {
    // Still down, but within the cooldown — keep a quiet trail without emailing.
    await logDebug({
      level: 'warn',
      source: 'browser-worker',
      message: `Browser worker still ${status.state}: ${status.detail}`,
    }).catch(() => {});
  }

  return { state: status.state, checked: true, alerted: alert };
}
