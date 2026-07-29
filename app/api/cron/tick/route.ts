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
      processQueuedJobs(1),
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

    const retention: Record<string, unknown> = {};
    const retentionTasks = [
      ['debug', () => admin.rpc('prune_debug_log', { p_keep_days: 14 })],
      ['webhooks', () => admin.rpc('prune_webhook_tables').maybeSingle()],
      ['operational', () => admin.rpc('prune_operational_tables').maybeSingle()],
      ['growth', () => admin.rpc('prune_growth_tables')],
    ] as const;
    for (const [name, run] of retentionTasks) {
      try {
        const result = await run();
        if (result.error) {
          retention[name] = { error: result.error.message };
          await logDebug({
            level: 'warn',
            source: `cron:retention:${name}`,
            message: result.error.message,
          });
        } else {
          retention[name] = result.data ?? null;
        }
      } catch (error) {
        const message = errorMessage(error);
        retention[name] = { error: message };
        await logDebug({ level: 'warn', source: `cron:retention:${name}`, message });
      }
    }

    return NextResponse.json({
      ok: true,
      ...outcome,
      retention,
      at: new Date().toISOString(),
    });
  } finally {
    const { error: releaseError } = await admin
      .from('app_leases')
      .delete()
      .eq('name', 'cron_tick')
      .eq('holder', holder);
    if (releaseError) {
      await logDebug({
        level: 'warn',
        source: 'cron:lease',
        message: `Could not release cron lease: ${releaseError.message}`,
      }).catch(() => {});
    }
  }
}
