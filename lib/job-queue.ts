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
import { applyScores } from '@/lib/scoring';

export type JobKind =
  | 'auto_search'
  | 'deep_search'
  | 'contact_enrichment'
  | 'score_contact'
  | 'email_delivery'
  | 'sms_delivery'
  | 'voicemail_delivery'
  | 'notification_delivery'
  | 'contact_side_effects';

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

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
  if (error?.code === '23505') {
    const existing = await supabase
      .from('job_queue')
      .select('id, status')
      .eq('dedupe_key', dedupeKey)
      .maybeSingle();
    if (existing.error) {
      await logDebug({
        level: 'error',
        source: 'job-queue',
        message: `Could not resolve duplicate ${kind} job: ${existing.error.message}`,
        context: { kind, dedupe_key: dedupeKey },
      }).catch(() => {});
      throw new Error(existing.error.message);
    }
    if (existing.data?.status === 'failed') {
      const retried = await supabase
        .from('job_queue')
        .update({
          status: 'pending',
          attempt_count: 0,
          available_at: new Date().toISOString(),
          locked_at: null,
          locked_by: null,
          last_error: null,
          completed_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.data.id)
        .eq('status', 'failed')
        .select('id')
        .maybeSingle();
      if (retried.error) throw new Error(retried.error.message);
      if (retried.data) {
        return {
          queued: true,
          duplicate: false,
          retried: true,
          id: retried.data.id as string,
          status: 'pending',
        };
      }
    }
    return {
      queued: false,
      duplicate: true,
      id: existing.data?.id as string | undefined,
      status: existing.data?.status as string | undefined,
    };
  }
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

export async function enqueueDeepSearchJob(input: {
  contactId: string;
  actorId: string;
  focusDate?: string | null;
  dedupeKey: string;
  maxAttempts?: number;
}) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .rpc('enqueue_deep_search_job', {
      p_contact_id: input.contactId,
      p_actor_id: input.actorId,
      p_focus_date: input.focusDate ?? null,
      p_dedupe_key: input.dedupeKey,
      p_max_attempts: input.maxAttempts ?? 2,
    })
    .single();
  if (error || !data) {
    throw new Error(
      `Could not atomically enqueue deep-search job: ${error?.message ?? 'RPC returned no row'}`
    );
  }
  const row = data as {
    id: string;
    queued: boolean;
    duplicate: boolean;
    retried: boolean;
    status: string;
  };
  return {
    id: String(row.id),
    queued: row.queued === true,
    duplicate: row.duplicate === true,
    retried: row.retried === true,
    status: String(row.status),
  };
}

async function refreshSmsCampaign(campaignId: string) {
  const supabase = createAdminClient();
  const { error } = await supabase.rpc('refresh_sms_campaign_counts', {
    p_campaign_id: campaignId,
  });
  if (error) throw new Error(error.message);
}

function nonRetryableError(message: string) {
  const error = new Error(message) as Error & { retryable: boolean };
  error.retryable = false;
  return error;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jobPayload(job: any): Record<string, unknown> {
  const payload = job?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw nonRetryableError(`${String(job?.kind ?? 'Unknown')} job payload must be an object`);
  }
  return payload as Record<string, unknown>;
}

function requiredPayloadUuid(
  payload: Record<string, unknown>,
  key: string,
  kind: unknown
): string {
  const value = payload[key];
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw nonRetryableError(
      `${String(kind ?? 'Unknown')} job payload is missing a valid ${key}`
    );
  }
  return value.toLowerCase();
}

async function handleJob(job: any, worker: string, signal?: AbortSignal) {
  const payload = jobPayload(job);
  const supabase = createAdminClient();
  if (signal?.aborted) throw signal.reason ?? new Error('Job lease was lost');

  if (job.kind === 'auto_search') {
    await runAutoSearchForContact(
      String(payload.contactId),
      (payload.actorId as string | null) ?? null,
      `job:${job.id}:attempt:${job.attempt_count}`
    );
    return;
  }

  if (job.kind === 'deep_search') {
    const contactId = requiredPayloadUuid(payload, 'contactId', job.kind);
    const focusDate =
      payload.focusDate === undefined
        ? undefined
        : typeof payload.focusDate === 'string' &&
            /^\d{4}-\d{2}-\d{2}$/.test(payload.focusDate)
          ? payload.focusDate
          : null;
    if (focusDate === null) {
      throw nonRetryableError('deep_search job payload has an invalid focusDate');
    }
    await runDeepSearchForContact(
      contactId,
      (payload.actorId as string | null) ?? null,
      {
        deadlineMs: 95_000,
        requestKey: `job:${job.id}:attempt:${job.attempt_count}`,
        signal,
        jobId: String(job.id),
        jobWorker: worker,
        jobAttempt: Number(job.attempt_count),
        // A focused run digs into one arrest of a multi-arrest person.
        focusDate,
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

  if (job.kind === 'score_contact') {
    await applyScores(String(payload.contactId));
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
    const { data: existing, error: readError } = await supabase
      .from('sms_messages')
      .select('status')
      .eq('id', String(payload.messageId))
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    if (!existing || existing.status !== 'queued') return;
    const result = await sendSms(String(payload.phone), String(payload.body));
    const status = result.ok ? 'sent' : 'failed';
    const { data: updatedMessage, error: updateError } = await supabase
      .from('sms_messages')
      .update({ status, error: result.error ?? null })
      .eq('id', String(payload.messageId))
      .eq('status', 'queued')
      .select('id')
      .maybeSingle();
    if (updateError) {
      throw nonRetryableError(`SMS provider result could not be recorded: ${updateError.message}`);
    }
    if (!updatedMessage) return;
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
    const { data: existing, error: sendReadError } = await supabase
      .from('voicemail_sends')
      .select('status, voicemail_drops ( lifecycle_status )')
      .eq('id', String(payload.sendId))
      .maybeSingle();
    if (sendReadError) throw new Error(sendReadError.message);
    if (
      !existing ||
      existing.status !== 'queued' ||
      (existing as any).voicemail_drops?.lifecycle_status !== 'active'
    ) {
      return;
    }
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
    const { data: updatedSend, error: sendUpdateError } = await supabase
      .from('voicemail_sends')
      .update({ status, error: result.error ?? null })
      .eq('id', String(payload.sendId))
      .eq('status', 'queued')
      .select('id')
      .maybeSingle();
    if (sendUpdateError) {
      throw nonRetryableError(
        `Voicemail provider result could not be recorded: ${sendUpdateError.message}`
      );
    }
    if (!updatedSend) {
      await logDebug({
        level: 'error',
        source: 'job:voicemail_delivery',
        message: 'Provider returned after the voicemail send was cancelled',
        context: { send_id: payload.sendId, drop_id: payload.dropId, provider_ok: result.ok },
        contactId: String(payload.contactId),
      });
      return;
    }
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
    const { data: existing, error: readError } = await supabase
      .from('notifications_log')
      .select('status')
      .eq('id', String(payload.notificationId))
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    if (!existing || existing.status === 'sent') return;
    let result: { ok: boolean; error?: string };
    if (payload.channel === 'email' && payload.destination) {
      result = await sendViaEmailit({
        to: String(payload.destination),
        // Client-facing alerts keep the default subject; internal alerts (e.g.
        // the admin countdown) pass their own so the inbox line makes sense.
        subject:
          typeof payload.subject === 'string' && payload.subject
            ? payload.subject
            : 'Update on your case',
        html: `<p>${escapeHtml(payload.message).replaceAll('\n', '<br/>')}</p>`,
      });
    } else if (payload.channel === 'sms' && payload.destination) {
      result = await sendSms(String(payload.destination), String(payload.message));
    } else {
      result = { ok: false, error: `No ${String(payload.channel)} destination on file` };
    }
    const { error: updateError } = await supabase
      .from('notifications_log')
      .update({ status: result.ok ? 'sent' : 'failed', error: result.error ?? null })
      .eq('id', String(payload.notificationId));
    if (updateError) {
      throw nonRetryableError(
        `Notification provider result could not be recorded: ${updateError.message}`
      );
    }
    if (!result.ok) throw new Error(result.error ?? 'Notification delivery failed');
    return;
  }

  if (job.kind === 'contact_side_effects') {
    const contactId = String(payload.contactId);
    const { data: contact, error } = await supabase
      .from('contacts')
      .select('*, statuses ( name, color, is_client_status )')
      .eq('id', contactId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!contact) return;
    const { fireNotification } = await import('@/lib/notifications');
    if (payload.event === 'link_status_change') {
      await fireNotification(
        'link_status_change',
        contact,
        { link: String(payload.link), link_status: String(payload.linkStatus) },
        { dedupeKey: `contact-link-status:${job.id}` }
      );
    } else {
      const toStatusId =
        typeof payload.toStatusId === 'string' && payload.toStatusId ? payload.toStatusId : undefined;
      const { stopEnrollmentsFor, startSequencesForStatus } = await import('@/lib/sequence-runner');
      await stopEnrollmentsFor(contactId, 'status_change', toStatusId);
      if (toStatusId) await startSequencesForStatus(contactId, toStatusId);
      const statusName = (contact as any).statuses?.name ?? 'none';
      await fireNotification(
        'status_change',
        contact,
        { status: statusName },
        { dedupeKey: `contact-status:${job.id}` }
      );
    }
    return;
  }

  throw new Error(`Unsupported job kind: ${job.kind}`);
}

async function completeJob(job: any, worker: string) {
  const supabase = createAdminClient();
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
    .eq('attempt_count', job.attempt_count)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`Lost lease before completing job ${job.id}`);
}

async function failJob(job: any, worker: string, failure: unknown) {
  const supabase = createAdminClient();
  const terminal =
    job.attempt_count >= job.max_attempts ||
    (failure as { retryable?: boolean } | null)?.retryable === false;
  const backoffMinutes = Math.min(60, 2 ** Math.max(0, job.attempt_count - 1));
  // JavaScript permits Promise.reject(undefined) and even `throw null`.
  // Completion and failure are separate functions so no falsy thrown value can
  // ever be mistaken for a successful job.
  const message = (errorMessage(failure) || 'Unknown job failure').slice(0, 2000);

  // Deep-search terminal failure has two pieces of state that must agree: the
  // queue attempt and the contact's amber/error state. The RPC verifies the
  // exact lease and changes both in one transaction, so a reclaimed worker
  // cannot clear state owned by its successor.
  const deepSearchContactId =
    job.kind === 'deep_search' &&
    job.payload &&
    typeof job.payload === 'object' &&
    !Array.isArray(job.payload) &&
    typeof job.payload.contactId === 'string' &&
    UUID_PATTERN.test(job.payload.contactId)
      ? job.payload.contactId
      : null;
  if (terminal && job.kind === 'deep_search') {
    const failureText = `the last deep search failed after ${job.attempt_count} attempt${
      job.attempt_count === 1 ? '' : 's'
    } (${message.slice(0, 300)})`;
    const { data: finalized, error: finalizeError } = await supabase.rpc(
      'fail_deep_search_attempt',
      {
        // NULL is deliberate for a malformed legacy payload. Migration 0028
        // resolves a pointed contact when possible and always terminally
        // transitions the exact leased queue row even when it is orphaned.
        p_contact_id: deepSearchContactId,
        p_job_id: String(job.id),
        p_worker: worker,
        p_attempt_count: Number(job.attempt_count),
        p_message: failureText,
      }
    );
    if (finalizeError) throw new Error(finalizeError.message);
    if (finalized !== true) {
      await logDebug({
        level: 'warn',
        source: 'job:deep_search',
        message: `Lost lease before atomically recording terminal failure: ${message}`,
        context: {
          job_id: job.id,
          worker,
          attempt: job.attempt_count,
        },
        contactId: deepSearchContactId,
      });
      return;
    }
    await logDebug({
      source: 'job:deep_search',
      message,
      context: { job_id: job.id, attempt: job.attempt_count, terminal: true },
      contactId: deepSearchContactId,
    });
    return;
  }

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
    .eq('attempt_count', job.attempt_count)
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

async function withJobHeartbeat<T>(
  job: any,
  worker: string,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const supabase = createAdminClient();
  let stopped = false;
  let heartbeatRunning = false;
  let lostLease: Error | null = null;
  let lastSuccessfulHeartbeat = Date.now();
  const controller = new AbortController();
  const abortForLeaseRisk = (message: string) => {
    if (lostLease) return;
    lostLease = new Error(message);
    controller.abort(lostLease);
    void logDebug({
      level: 'error',
      source: `job:${job.kind}`,
      message,
      context: {
        job_id: job.id,
        worker,
        attempt: job.attempt_count,
        last_successful_heartbeat_at: new Date(lastSuccessfulHeartbeat).toISOString(),
      },
    });
  };
  const timer = setInterval(() => {
    if (stopped || heartbeatRunning) return;
    heartbeatRunning = true;
    void (async () => {
      try {
        const { data, error } = await supabase
          .from('job_queue')
          .update({ locked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', job.id)
          .eq('status', 'processing')
          .eq('locked_by', worker)
          .eq('attempt_count', job.attempt_count)
          .select('id')
          .maybeSingle();
        if (error) {
          await logDebug({
            level: 'warn',
            source: `job:${job.kind}`,
            message: `Could not renew job lease: ${error.message}`,
            context: { job_id: job.id, worker },
          });
        } else if (!data) {
          // Deep search finalizes its queue row inside the same transaction as
          // its contact state. A heartbeat already waiting on that row wakes
          // after commit and correctly finds no *processing* row. Distinguish
          // that exact completed attempt from a genuine lease takeover.
          const { data: current, error: currentError } = await supabase
            .from('job_queue')
            .select('status, attempt_count')
            .eq('id', job.id)
            .maybeSingle();
          const finalizedThisAttempt =
            !currentError &&
            job.kind === 'deep_search' &&
            current?.status === 'completed' &&
            Number(current.attempt_count) === Number(job.attempt_count);
          if (!finalizedThisAttempt) {
            lostLease = new Error(
              currentError
                ? `Lost lease while processing job ${job.id}; state check failed: ${currentError.message}`
                : `Lost lease while processing job ${job.id}`
            );
            controller.abort(lostLease);
            await logDebug({
              level: 'warn',
              source: `job:${job.kind}`,
              message: lostLease.message,
              context: { job_id: job.id, worker, attempt: job.attempt_count },
            });
          }
        } else {
          lastSuccessfulHeartbeat = Date.now();
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
  // The renewal request itself can hang. Keep a separate watchdog so a worker
  // stops paid/provider work before its database lease can be reclaimed.
  const leaseWatchdog = setInterval(() => {
    if (
      !stopped &&
      Date.now() - lastSuccessfulHeartbeat >=
        (JOB_LEASE_SECONDS - JOB_LEASE_ABORT_MARGIN_SECONDS) * 1000
    ) {
      abortForLeaseRisk(
        `Could not confirm job lease for ${JOB_LEASE_SECONDS - JOB_LEASE_ABORT_MARGIN_SECONDS}s; ` +
          'aborted before another worker could reclaim it'
      );
    }
  }, 15_000);
  leaseWatchdog.unref?.();
  try {
    const result = await run(controller.signal);
    if (lostLease) throw lostLease;
    return result;
  } finally {
    stopped = true;
    clearInterval(timer);
    clearInterval(leaseWatchdog);
  }
}

const JOB_LEASE_SECONDS = 300;
const JOB_LEASE_ABORT_MARGIN_SECONDS = 60;

/** Claims a deliberately small batch so one cron invocation has a hard ceiling. */
export async function processQueuedJobs(limit = 1, opts?: { light?: boolean }) {
  const worker = randomUUID();
  const supabase = createAdminClient();
  // The light path claims only the cheap, batchable kinds (see claim_light_jobs)
  // so a scoring backlog can't starve the heavy/external one-per-tick path.
  const { data: jobs, error } = await supabase.rpc(
    opts?.light ? 'claim_light_jobs' : 'claim_jobs',
    {
      p_worker: worker,
      p_limit: Math.min(Math.max(limit, 1), opts?.light ? 100 : 2),
      p_lease_seconds: JOB_LEASE_SECONDS,
    }
  );
  if (error) throw new Error(error.message);

  let completed = 0;
  let failed = 0;
  // Sequential execution is intentional: a deep-search job may own Chrome and
  // several provider sockets. Database claiming already distributes work across
  // ticks; parallel work here only creates RAM and latency spikes.
  for (const job of jobs ?? []) {
    try {
      await withJobHeartbeat(job, worker, (signal) => handleJob(job, worker, signal));
      // A deep search commits its contact results and this exact queue attempt
      // together. A second generic completion write would always look like a
      // lost lease and could obscure a successful run.
      if (job.kind !== 'deep_search') await completeJob(job, worker);
      completed += 1;
    } catch (failure) {
      await failJob(job, worker, failure);
      failed += 1;
    }
  }
  return { claimed: jobs?.length ?? 0, completed, failed };
}
