import { randomUUID } from 'crypto';
import { createAdminClient } from '@/lib/supabase/server';
import { runAutoSearchForContact } from '@/lib/lead-intake';
import { runDeepSearchForContact } from '@/lib/deep-search';
import { enrichContactFromPhone } from '@/lib/enrichment';
import { sendCrmEmail } from '@/lib/email-send';
import { sendSms } from '@/lib/integrations/textlink';
import { sendVoicemailDrop } from '@/lib/integrations/voicemail';
import { sendViaEmailit } from '@/lib/integrations/emailit';
import { logActivity } from '@/lib/activity';
import { errorMessage, logDebug } from '@/lib/debug-log';

export type JobKind =
  | 'auto_search'
  | 'deep_search'
  | 'contact_enrichment'
  | 'email_delivery'
  | 'sms_delivery'
  | 'voicemail_delivery'
  | 'notification_delivery';

export async function enqueueJob(
  kind: JobKind,
  payload: Record<string, unknown>,
  dedupeKey: string,
  maxAttempts = 5
) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('job_queue')
    .insert({
      kind,
      payload,
      dedupe_key: dedupeKey,
      max_attempts: maxAttempts,
    })
    .select('id')
    .single();
  if (error?.code === '23505') return { queued: false, duplicate: true };
  if (error || !data) {
    // Log before throwing. A rejected insert used to leave nothing behind: no
    // row, no debug entry, and a 500 whose body the caller could not parse. A
    // kind missing from job_queue_kind_check (23514) cost an afternoon looking
    // like a hung button, when the database had said exactly what was wrong.
    const constraintHint =
      error?.code === '23514'
        ? ` — "${kind}" is not permitted by job_queue_kind_check, which means a migration adding it has not been run against this database`
        : '';
    await logDebug({
      level: 'error',
      source: 'job-queue',
      message: `Could not enqueue ${kind}: ${error?.message ?? 'insert returned no row'}${constraintHint}`,
      context: {
        kind,
        dedupe_key: dedupeKey,
        code: error?.code ?? null,
        details: error?.details ?? null,
        hint: error?.hint ?? null,
      },
      // Never let a logging failure replace the error we are reporting.
    }).catch(() => {});
    throw new Error(
      `Could not enqueue ${kind} job: ${error?.message ?? 'insert returned no row'}${constraintHint}`
    );
  }
  return { queued: true, duplicate: false, id: data.id as string };
}

async function refreshSmsCampaign(campaignId: string) {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('sms_messages')
    .select('status')
    .eq('campaign_id', campaignId);
  const statuses = (data ?? []).map((row) => row.status);
  const sent = statuses.filter((status) => status === 'sent').length;
  const failed = statuses.filter((status) => status === 'failed').length;
  const queued = statuses.filter((status) => status === 'queued').length;
  await supabase
    .from('sms_campaigns')
    .update({
      status: queued ? 'sending' : failed && !sent ? 'failed' : 'sent',
      sent_count: sent,
      failed_count: failed,
    })
    .eq('id', campaignId);
}

async function handleJob(job: any) {
  const payload = job.payload ?? {};
  const supabase = createAdminClient();

  if (job.kind === 'auto_search') {
    await runAutoSearchForContact(
      String(payload.contactId),
      (payload.actorId as string | null) ?? null,
      `job:${job.id}:attempt:${job.attempt_count}`
    );
    return;
  }

  if (job.kind === 'deep_search') {
    await runDeepSearchForContact(
      String(payload.contactId),
      (payload.actorId as string | null) ?? null,
      {
        deadlineMs: 95_000,
        requestKey: `job:${job.id}:attempt:${job.attempt_count}`,
      }
    );
    return;
  }

  if (job.kind === 'contact_enrichment') {
    // Fills a blank name/city/state from the caller's number. Never runs in the
    // webhook: CallScaler retries a slow delivery, and a retried webhook is how
    // one submission became several contacts.
    const result = await enrichContactFromPhone(String(payload.contactId), {
      actorId: (payload.actorId as string | null) ?? null,
    });
    // A lookup that found nothing is a normal outcome, not a failure to retry.
    // Only a thrown error (network, database) marks the job failed.
    if (result.filled.includes('name')) {
      // A real name is what makes the automatic search worth running at all, so
      // the search is chained here rather than guessed at enqueue time.
      await enqueueJob(
        'auto_search',
        { contactId: String(payload.contactId) },
        `auto-search:enriched:${payload.contactId}`
      );
    }
    return;
  }

  if (job.kind === 'email_delivery') {
    const result = await sendCrmEmail({
      to: String(payload.to),
      subject: String(payload.subject),
      html: String(payload.html),
      accountId: (payload.accountId as string | null) ?? null,
      contactId: (payload.contactId as string | null) ?? null,
      actorId: (payload.actorId as string | null) ?? null,
      deliveryKey: String(payload.deliveryKey),
    });
    if (!result.ok) throw new Error(result.error ?? 'Email delivery failed');
    return;
  }

  if (job.kind === 'sms_delivery') {
    const { data: existing } = await supabase
      .from('sms_messages')
      .select('status')
      .eq('id', String(payload.messageId))
      .maybeSingle();
    if (existing?.status === 'sent') return;
    const result = await sendSms(String(payload.phone), String(payload.body));
    const status = result.ok ? 'sent' : 'failed';
    await supabase
      .from('sms_messages')
      .update({ status, error: result.error ?? null })
      .eq('id', String(payload.messageId));
    await logActivity({
      contactId: String(payload.contactId),
      actorId: (payload.actorId as string | null) ?? null,
      type: 'sms',
      description: result.ok
        ? `SMS sent (campaign "${String(payload.campaignName)}")`
        : `SMS failed: ${result.error ?? 'unknown'}`,
    });
    await refreshSmsCampaign(String(payload.campaignId));
    if (!result.ok) throw new Error(result.error ?? 'SMS delivery failed');
    return;
  }

  if (job.kind === 'voicemail_delivery') {
    const { data: existing } = await supabase
      .from('voicemail_sends')
      .select('status')
      .eq('id', String(payload.sendId))
      .maybeSingle();
    if (existing?.status === 'sent') return;
    const { data: signed, error: signError } = await supabase.storage
      .from('voicemail-audio')
      .createSignedUrl(String(payload.audioPath), 3600);
    if (signError || !signed?.signedUrl) {
      throw new Error(signError?.message ?? 'Could not sign voicemail audio URL');
    }
    const result = await sendVoicemailDrop({
      phone: String(payload.phone),
      audioUrl: signed.signedUrl,
    });
    const status = result.ok ? 'sent' : 'failed';
    await supabase
      .from('voicemail_sends')
      .update({ status, error: result.error ?? null })
      .eq('id', String(payload.sendId));
    await logActivity({
      contactId: String(payload.contactId),
      actorId: (payload.actorId as string | null) ?? null,
      type: 'voicemail',
      description: result.ok
        ? `Voicemail drop sent ("${String(payload.dropName)}")`
        : `Voicemail drop failed: ${result.error ?? 'unknown'}`,
    });
    if (!result.ok) throw new Error(result.error ?? 'Voicemail delivery failed');
    return;
  }

  if (job.kind === 'notification_delivery') {
    const { data: existing } = await supabase
      .from('notifications_log')
      .select('status')
      .eq('id', String(payload.notificationId))
      .maybeSingle();
    if (existing?.status === 'sent') return;
    let result: { ok: boolean; error?: string };
    if (payload.channel === 'email' && payload.destination) {
      result = await sendViaEmailit({
        to: String(payload.destination),
        subject: 'Update on your case',
        html: `<p>${String(payload.message)}</p>`,
      });
    } else if (payload.channel === 'sms' && payload.destination) {
      result = await sendSms(String(payload.destination), String(payload.message));
    } else {
      result = { ok: false, error: `No ${String(payload.channel)} destination on file` };
    }
    await supabase
      .from('notifications_log')
      .update({ status: result.ok ? 'sent' : 'failed', error: result.error ?? null })
      .eq('id', String(payload.notificationId));
    if (!result.ok) throw new Error(result.error ?? 'Notification delivery failed');
    return;
  }

  throw new Error(`Unsupported job kind: ${job.kind}`);
}

async function finishJob(job: any, worker: string, failure?: unknown) {
  const supabase = createAdminClient();
  if (!failure) {
    const { data, error } = await supabase
      .from('job_queue')
      .update({
        status: 'completed',
        locked_at: null,
        locked_by: null,
        last_error: null,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
      .eq('status', 'processing')
      .eq('locked_by', worker)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`Lost lease before completing job ${job.id}`);
    return;
  }

  const terminal = job.attempt_count >= job.max_attempts;
  const backoffMinutes = Math.min(60, 2 ** Math.max(0, job.attempt_count - 1));
  const message = errorMessage(failure).slice(0, 2000);
  const { data, error } = await supabase
    .from('job_queue')
    .update({
      status: terminal ? 'failed' : 'pending',
      available_at: terminal
        ? new Date().toISOString()
        : new Date(Date.now() + backoffMinutes * 60_000).toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: message,
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id)
    .eq('status', 'processing')
    .eq('locked_by', worker)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    await logDebug({
      level: 'warn',
      source: `job:${job.kind}`,
      message: `Lost lease before recording job failure: ${message}`,
      context: { job_id: job.id, worker },
    });
    return;
  }
  await logDebug({
    source: `job:${job.kind}`,
    message,
    context: { job_id: job.id, attempt: job.attempt_count, terminal },
  });
}

async function withJobHeartbeat<T>(job: any, worker: string, run: () => Promise<T>): Promise<T> {
  const supabase = createAdminClient();
  let stopped = false;
  let heartbeatRunning = false;
  const timer = setInterval(() => {
    if (stopped || heartbeatRunning) return;
    heartbeatRunning = true;
    void (async () => {
      try {
        const { error } = await supabase
          .from('job_queue')
          .update({ locked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', job.id)
          .eq('status', 'processing')
          .eq('locked_by', worker);
        if (error) {
          await logDebug({
            level: 'warn',
            source: `job:${job.kind}`,
            message: `Could not renew job lease: ${error.message}`,
            context: { job_id: job.id, worker },
          });
        }
      } catch (heartbeatError) {
        await logDebug({
          level: 'warn',
          source: `job:${job.kind}`,
          message: `Could not renew job lease: ${errorMessage(heartbeatError)}`,
          context: { job_id: job.id, worker },
        }).catch(() => {});
      } finally {
        heartbeatRunning = false;
      }
    })();
  }, 30_000);
  timer.unref?.();
  try {
    return await run();
  } finally {
    stopped = true;
    clearInterval(timer);
  }
}

/** Claims a deliberately small batch so one cron invocation has a hard ceiling. */
export async function processQueuedJobs(limit = 1) {
  const worker = randomUUID();
  const supabase = createAdminClient();
  const { data: jobs, error } = await supabase.rpc('claim_jobs', {
    p_worker: worker,
    p_limit: Math.min(Math.max(limit, 1), 2),
    p_lease_seconds: 150,
  });
  if (error) throw new Error(error.message);

  let completed = 0;
  let failed = 0;
  // Sequential execution is intentional: a deep-search job may own Chrome and
  // several provider sockets. Database claiming already distributes work across
  // ticks; parallel work here only creates RAM and latency spikes.
  for (const job of jobs ?? []) {
    try {
      await withJobHeartbeat(job, worker, () => handleJob(job));
      await finishJob(job, worker);
      completed += 1;
    } catch (failure) {
      await finishJob(job, worker, failure);
      failed += 1;
    }
  }
  return { claimed: jobs?.length ?? 0, completed, failed };
}
