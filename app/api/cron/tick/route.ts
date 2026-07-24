import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { processDueEnrollments } from '@/lib/sequence-runner';
import { processCountdownNotifications } from '@/lib/notifications';
import { syncMissedCalls } from '@/lib/integrations/callscaler';
import { verifyBearerSecret } from '@/lib/webhook-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { logDebug, errorMessage } from '@/lib/debug-log';
import { processQueuedJobs } from '@/lib/job-queue';

export const maxDuration = 120;
const LEASE_SECONDS = 180;

/**
 * Bounded heartbeat. Provider work lives in a durable queue and each tick
 * claims only a small batch, so scheduler overlap cannot multiply processes.
 */
export async function GET(request: Request) {
  if (!verifyBearerSecret(request, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Invalid secret' }, { status: 401 });
  }

  const admin = createAdminClient();
  const holder = randomUUID();
  const { data: acquired, error: leaseError } = await admin.rpc('try_acquire_app_lease', {
    p_name: 'cron_tick',
    p_holder: holder,
    p_ttl_seconds: LEASE_SECONDS,
  });
  if (leaseError) {
    return NextResponse.json({ error: leaseError.message }, { status: 503 });
  }
  if (!acquired) {
    return NextResponse.json({
      ok: true,
      skipped: 'previous tick still running',
      at: new Date().toISOString(),
    });
  }

  try {
    const names = ['sequences', 'countdown', 'calls', 'jobs'] as const;
    const results = await Promise.allSettled([
      processDueEnrollments(2),
      processCountdownNotifications(),
      syncMissedCalls(),
      processQueuedJobs(2),
    ]);
    const outcome: Record<string, any> = {};
    await Promise.all(
      results.map(async (result, index) => {
        const name = names[index];
        if (result.status === 'fulfilled') {
          outcome[name] = result.value;
        } else {
          const message = errorMessage(result.reason);
          outcome[name] = { error: message };
          await logDebug({ source: `cron:${name}`, message });
        }
      })
    );

    let pruned: number | null = null;
    let webhookPruned: any = null;
    let operationalPruned: any = null;
    try {
      const { data } = await admin.rpc('prune_debug_log', { p_keep_days: 14 });
      pruned = typeof data === 'number' ? data : null;
      const { data: wh } = await admin.rpc('prune_webhook_tables').maybeSingle();
      webhookPruned = wh ?? null;
      const { data: operational } = await admin.rpc('prune_operational_tables').maybeSingle();
      operationalPruned = operational ?? null;
    } catch {
      // Retention is best effort and must not fail the worker.
    }

    return NextResponse.json({
      ok: true,
      ...outcome,
      pruned,
      webhook_pruned: webhookPruned,
      operational_pruned: operationalPruned,
      at: new Date().toISOString(),
    });
  } finally {
    await admin.from('app_leases').delete().eq('name', 'cron_tick').eq('holder', holder);
  }
}
