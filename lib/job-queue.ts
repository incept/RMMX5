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

async function handleJob(job: any, signal?: AbortSignal) {
  const payload = job.payload ?? {};
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
    await runDeepSearchForContact(
      String(payload.contactId),
      (payload.actorId as string | null) ?? null,
      {
        deadlineMs: 95_000,
        requestKey: `job:${job.id}:attempt:${job.attempt_count}`,
        signal,
        jobId: String(job.id),
        // A focused run digs into one arrest of a multi-arrest person.
        focusDate: typeof payload.focusDate === 'string' ? payload.focusDate : undefined,
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
        subject: 'Update on your case',
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

  const terminal =
    job.attempt_count >= job.max_attempts ||
    (failure as { retryable?: boolean } | null)?.retryable === false;
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

  // A deep search that fails its last attempt must not leave the contact
  // wearing the amber "queued" icon forever with the error hidden in the job
  // table. Clear the stamp and raise the search flag so the Link Data banner
  // says WHY and invites a re-run. Best-effort: this write failing must not
  // mask the recorded job failure.
  if (terminal && job.kind === 'deep_search' && job.payload?.contactId) {
    const failureText = `the last deep search failed after ${job.attempt_count} attempt${
      job.attempt_count === 1 ? '' : 's'
    } (${message.slice(0, 300)})`;
    const { error: stampError } = await supabase.rpc('fail_deep_search_state', {
      p_contact_id: String(job.payload.contactId),
      p_job_id: String(job.id),
      p_message: failureText,
    });
    if (stampError) {
      await logDebug({
        level: 'warn',
        source: 'job:deep_search',
        message: `Could not clear the queued stamp after terminal failure: ${stampError.message}`,
        contactId: String(job.payload.contactId),
      }).catch(() => {});
    }
  }
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
  const controller = new AbortController();
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
          lostLease = new Error(`Lost lease while processing job ${job.id}`);
          controller.abort(lostLease);
          await logDebug({
            level: 'warn',
            source: `job:${job.kind}`,
            message: lostLease.message,
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
    const result = await run(controller.signal);
    if (lostLease) throw lostLease;
    return result;
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
      await withJobHeartbeat(job, worker, (signal) => handleJob(job, signal));
      await finishJob(job, worker);
      completed += 1;
    } catch (failure) {
      await finishJob(job, worker, failure);
      failed += 1;
    }
  }
  return { claimed: jobs?.length ?? 0, completed, failed };
}
