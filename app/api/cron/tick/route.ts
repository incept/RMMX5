import { NextResponse } from 'next/server';
import { processDueEnrollments } from '@/lib/sequence-runner';
import { processCountdownNotifications } from '@/lib/notifications';
import { syncMissedCalls } from '@/lib/integrations/callscaler';
import { verifyBearerSecret } from '@/lib/webhook-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { getSetting, setSetting } from '@/lib/settings';
import { logDebug, errorMessage } from '@/lib/debug-log';

// A tick that outlives this is doing something wrong (e.g. a hung SMTP
// conversation × 25 enrollments); kill it rather than pile up processes.
export const maxDuration = 120;

// A tick younger than this is assumed still running; new ticks bow out. Kept
// under the scheduler interval so a crashed tick can't lock the cron out for
// long — the stale lock simply expires by aging past this window.
const OVERLAP_WINDOW_MS = 4 * 60 * 1000;

/**
 * The heartbeat. Call it every 5–15 minutes from any scheduler:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "https://yourdomain.com/api/cron/tick"
 *
 * Each tick: sends due sequence emails and fires client-countdown
 * notifications. Both are idempotent, so over-calling is harmless.
 */
export async function GET(request: Request) {
  if (!verifyBearerSecret(request, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Invalid secret' }, { status: 401 });
  }

  // Overlap guard: sequential email sends over slow SMTP can outlast the
  // scheduler interval, and overlapping ticks were one source of the
  // worker-process pileup that took the site down. The claim RPC already
  // prevents double-SENDS — this prevents double-RUNNING. Best-effort
  // (read-then-write), which is fine at cron cadence.
  const lock = await getSetting<{ started_at?: string }>('cron_lock');
  const lockAge = lock.started_at ? Date.now() - new Date(lock.started_at).getTime() : Infinity;
  if (lockAge < OVERLAP_WINDOW_MS) {
    return NextResponse.json({ ok: true, skipped: 'previous tick still running', at: new Date().toISOString() });
  }
  await setSetting('cron_lock', { started_at: new Date().toISOString() });

  let sequences: any = null;
  let countdown: any = null;
  let calls: any = null;
  try {
    sequences = await processDueEnrollments();
  } catch (e) {
    await logDebug({ source: 'cron:sequences', message: errorMessage(e) });
    sequences = { error: errorMessage(e) };
  }
  try {
    countdown = await processCountdownNotifications();
  } catch (e) {
    await logDebug({ source: 'cron:countdown', message: errorMessage(e) });
    countdown = { error: errorMessage(e) };
  }
  // Backfills any CallScaler calls whose webhook delivery was missed
  // (their retries stop after ~2.5 minutes). No-op until an API key is set.
  try {
    calls = await syncMissedCalls();
  } catch (e) {
    await logDebug({ source: 'cron:callscaler', message: errorMessage(e) });
    calls = { error: errorMessage(e) };
  }

  // Keep the log + webhook tables bounded. Best-effort: pruning must not
  // fail the tick.
  let pruned: number | null = null;
  let webhookPruned: any = null;
  try {
    const admin = createAdminClient();
    const { data } = await admin.rpc('prune_debug_log', { p_keep_days: 14 });
    pruned = typeof data === 'number' ? data : null;
    const { data: wh } = await admin.rpc('prune_webhook_tables').maybeSingle();
    webhookPruned = wh ?? null;
  } catch {
    // ignore
  }

  await setSetting('cron_lock', {});

  return NextResponse.json({
    ok: true,
    sequences,
    countdown,
    calls,
    pruned,
    webhook_pruned: webhookPruned,
    at: new Date().toISOString(),
  });
}
