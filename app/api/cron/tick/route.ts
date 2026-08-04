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
import { checkSchemaVersion } from '@/lib/schema-version';
import { pruneUnreferencedEmailAssets } from '@/lib/email-assets';
import { monitorBrowserWorker } from '@/lib/browser-worker-health';

export const maxDuration = 120;
const LEASE_SECONDS = 180;

/**
 * Fast scoring jobs drain in a batch each tick so an import's scoring backlog
 * (a score_contact job per imported contact) can't starve email/SMS and other
 * work queued behind it; the heavy/external jobs keep their one-per-tick pace.
 * skip-locked makes the two claims safe to run together.
 */
async function drainQueue() {
  // Three independent lanes (skip-locked makes concurrent claims safe): light,
  // imap, and the browser-heavy rest. IMAP has its own lane so a mailbox sync or
  // write-back reconcile never waits behind a deep search (finding #8).
  //
  // allSettled, NOT all: the lanes are independent, so one blowing up — e.g. an
  // imap lane whose claim_imap_jobs function isn't there yet because migration
  // 0051 hasn't been applied — must never take down email/SMS delivery on the
  // light lane. A failed lane is logged and counted, not propagated.
  const lanes = ['light', 'imap', 'heavy'] as const;
  const settled = await Promise.allSettled([
    processQueuedJobs(20, { light: true }),
    processQueuedJobs(3, { imap: true }),
    processQueuedJobs(1),
  ]);
  let claimed = 0;
  let completed = 0;
  let failed = 0;
  await Promise.all(
    settled.map(async (r, i) => {
      if (r.status === 'fulfilled') {
        claimed += r.value.claimed;
        completed += r.value.completed;
        failed += r.value.failed;
      } else {
        failed += 1;
        await logDebug({
          level: 'error',
          source: `cron:drain:${lanes[i]}`,
          message: `Job lane failed to drain: ${errorMessage(r.reason)}`,
        }).catch(() => {});
      }
    })
  );
  return { claimed, completed, failed };
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
    const schema = await checkSchemaVersion(admin);
    if (!schema.ok) {
      await logDebug({
        level: 'error',
        source: 'cron:schema',
        message: schema.error ?? 'Database schema is incompatible with this deployment',
        context: { expected: schema.expected, actual: schema.actual },
      }).catch(() => {});
    }
    const names = [
      'sequences',
      'countdown',
      'calls',
      'jobs',
      'rechecks',
      'imapsync',
      'browser',
    ] as const;
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
      // Throttled /healthz probe of the browser worker; alerts admins when the
      // tier that reads arrests.org is set up but not working.
      monitorBrowserWorker(),
    ]);
    const outcome: Record<string, any> = { schema };
    let degraded = !schema.ok;
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
    try {
      retention.email_assets = await pruneUnreferencedEmailAssets(admin);
    } catch (error) {
      const message = errorMessage(error);
      retention.email_assets = { error: message };
      await logDebug({
        level: 'warn',
        source: 'cron:retention:email-assets',
        message,
      }).catch(() => {});
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
