import { randomUUID } from 'crypto';
import { createAdminClient } from '@/lib/supabase/server';
import { runAutoSearchForContact } from '@/lib/lead-intake';
import { runDeepSearchForContact } from '@/lib/deep-search';
import { sendCrmEmail } from '@/lib/email-send';
import { sendSms } from '@/lib/integrations/textlink';
import { sendVoicemailDrop } from '@/lib/integrations/voicemail';
import { sendViaEmailit } from '@/lib/integrations/emailit';
import { logActivity } from '@/lib/activity';
import { errorMessage, logDebug } from '@/lib/debug-log';

export type JobKind =
  | 'auto_search'
  | 'deep_search'
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
  if (error || !data) throw new Error(error?.message ?? 'Could not enqueue job');
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
    await runAutoSearchForContact(String(payload.contactId));
    return;
  }

  if (job.kind === 'deep_search') {
    await runDeepSearchForContact(String(payload.contactId));
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

async function finishJob(job: any, failure?: unknown) {
  const supabase = createAdminClient();
  if (!failure) {
    const { error } = await supabase
      .from('job_queue')
      .update({
        status: 'completed',
        locked_at: null,
        locked_by: null,
        last_error: null,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);
    if (error) throw new Error(error.message);
    return;
  }

  const terminal = job.attempt_count >= job.max_attempts;
  const backoffMinutes = Math.min(60, 2 ** Math.max(0, job.attempt_count - 1));
  const message = errorMessage(failure).slice(0, 2000);
  await supabase
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
    .eq('id', job.id);
  await logDebug({
    source: `job:${job.kind}`,
    message,
    context: { job_id: job.id, attempt: job.attempt_count, terminal },
  });
}

/** Claims a deliberately small batch so one cron invocation has a hard ceiling. */
export async function processQueuedJobs(limit = 2) {
  const worker = randomUUID();
  const supabase = createAdminClient();
  const { data: jobs, error } = await supabase.rpc('claim_jobs', {
    p_worker: worker,
    p_limit: Math.min(Math.max(limit, 1), 4),
    p_lease_seconds: 150,
  });
  if (error) throw new Error(error.message);

  let completed = 0;
  let failed = 0;
  await Promise.all(
    (jobs ?? []).map(async (job: any) => {
      try {
        await handleJob(job);
        await finishJob(job);
        completed += 1;
      } catch (failure) {
        await finishJob(job, failure);
        failed += 1;
      }
    })
  );
  return { claimed: jobs?.length ?? 0, completed, failed };
}
