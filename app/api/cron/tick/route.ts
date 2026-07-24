import { NextResponse } from 'next/server';
import { processDueEnrollments } from '@/lib/sequence-runner';
import { processCountdownNotifications } from '@/lib/notifications';
import { verifyBearerSecret } from '@/lib/webhook-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { logDebug, errorMessage } from '@/lib/debug-log';

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

  let sequences: any = null;
  let countdown: any = null;
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

  // Keep debug_log bounded. Best-effort: pruning must not fail the tick.
  let pruned: number | null = null;
  try {
    const { data } = await createAdminClient().rpc('prune_debug_log', { p_keep_days: 14 });
    pruned = typeof data === 'number' ? data : null;
  } catch {
    // ignore
  }

  return NextResponse.json({
    ok: true,
    sequences,
    countdown,
    pruned,
    at: new Date().toISOString(),
  });
}
