import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { processDueEnrollments } from '@/lib/sequence-runner';
import { processCountdownNotifications } from '@/lib/notifications';
import { syncMissedCalls } from '@/lib/integrations/callscaler';
import { verifyBearerSecret } from '@/lib/webhook-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { logDebug, errorMessage } from '@/lib/debug-log';
import { processQueuedJobs } from '@/lib/job-queue';
import { processLinkRechecks } from '@/lib/link-recheck';
import { enqueueDueImapSyncs } from '@/lib/integrations/imap-sync';

export const maxDuration = 120;
const LEASE_SECONDS = 180;

/**
 * Fast scoring jobs drain in a batch each tick so an import's scoring backlog
 * (a score_contact job per imported contact) can't starve email/SMS and other
 * work queued behind it; the heavy/external jobs keep their one-per-tick pace.
 * skip-locked makes the two claims safe to run together.
 */
async function drainQueue() {
  const [fast, rest] = await Promise.all([
    processQueuedJobs(20, { light: true }),
    processQueuedJobs(1),
  ]);
  return {
    claimed: fast.claimed + rest.claimed,
    completed: fast.completed + rest.completed,
    failed: fast.failed + rest.failed,
  };
}

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
    const names = ['sequences', 'countdown', 'calls', 'jobs', 'rechecks', 'imapsync'] as const;
    const results = await Promise.allSettled([
      processDueEnrollments(2),
      processCountdownNotifications(),
      syncMissedCalls(),
      drainQueue(),
      // Cheap: claims due client links and enqueues link_recheck jobs; the
      // actual fetches run on the heavy lane, not in this tick.
      processLinkRechecks(),
      // Cheap: enqueues an imap_sync job per receiving account; the mailbox fetch
      // runs on the heavy lane (the VPS), not in this tick.
      enqueueDueImapSyncs(),
    ]);
    const outcome: Record<string, any> = {};
    let degraded = false;
    await Promise.all(
      results.map(async (result, index) => {
        const name = names[index];
        if (result.status === 'fulfilled') {
          outcome[name] = result.value;
          // A durable worker records its own retry, but the scheduler still
          // needs a non-success status so a failed provider job is observable
          // outside the application instead of looking like a healthy tick.
          if (
            name === 'jobs' &&
            Number((result.value as { failed?: number } | null)?.failed ?? 0) > 0
          ) {
            degraded = true;
          }
        } else {
          degraded = true;
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

    return NextResponse.json(
      {
        ok: !degraded,
        ...outcome,
        retention,
        at: new Date().toISOString(),
      },
      { status: degraded ? 500 : 200 }
    );
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
