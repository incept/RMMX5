import { createAdminClient } from '@/lib/supabase/server';
import { getSetting, setSetting } from '@/lib/settings';
import { logActivity } from '@/lib/activity';
import { logDebug, errorMessage } from '@/lib/debug-log';
import { parseCallScalerPage } from '@/lib/callscaler-page';
import { parseAllowedNumbers, isTrackingNumberAllowed } from '@/lib/callscaler-filter';
import { readResponseText } from '@/lib/request-limits';

const API_BASE = 'https://callscaler.com/api/v1';
const SKIP_CATEGORIES = new Set(['spam', 'wrong_number']);

export interface ProcessedCall {
  callId: string;
  duplicate: boolean;
  skipped?: string;
  contactId?: string;
  createdContact?: boolean;
  searchContactId?: string;
}

function phoneDigits(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : null;
}

export function looksLikeHumanName(name: string | null | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  const words = trimmed.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  if (!/^[a-zA-Z'.\- ]+$/.test(trimmed)) return false;
  return !/wireless|caller|unknown|unavailable|cellular|mobile|voip|toll|free|private|blocked|verified|spam|llc\b|inc\b/i.test(
    trimmed
  );
}

function formatDuration(seconds: number | null | undefined): string {
  const value = Math.max(0, Number(seconds) || 0);
  return value >= 60 ? `${Math.floor(value / 60)}m ${value % 60}s` : `${value}s`;
}

async function findMatchingContact(
  payload: Record<string, any>
): Promise<{ id: string; phone: string | null } | null> {
  const supabase = createAdminClient();
  if (payload.gclid) {
    const { data, error } = await supabase
      .from('contacts')
      .select('id, phone')
      .eq('gclid', payload.gclid)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return data;
  }

  const normalized = phoneDigits(payload.caller_number);
  if (!normalized) return null;
  const { data, error } = await supabase
    .from('contacts')
    .select('id, phone')
    .eq('phone_normalized', normalized)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

function callFields(payload: Record<string, any>) {
  const rawText = JSON.stringify(payload);
  const boundedRaw =
    Buffer.byteLength(rawText, 'utf8') <= 128 * 1024
      ? payload
      : {
          truncated: true,
          original_bytes: Buffer.byteLength(rawText, 'utf8'),
          keys: Object.keys(payload).slice(0, 200),
        };
  return {
    direction: payload.direction ?? null,
    status: payload.status ?? null,
    caller_number: payload.caller_number ?? null,
    caller_name: payload.caller_name ?? null,
    tracking_number: payload.tracking_number ?? null,
    duration_seconds: payload.duration_seconds ?? null,
    recording_url: payload.recording_url ?? null,
    transcription: payload.transcription ?? null,
    summary: payload.summary ?? null,
    ai_score: payload.ai_score ?? null,
    ai_category: payload.ai_category ?? null,
    qualified_ai: payload.qualified_ai ?? null,
    source: payload.source ?? payload.utm_source ?? null,
    raw: boundedRaw,
    started_at: payload.created_at ? new Date(payload.created_at).toISOString() : null,
  };
}

/**
 * Claims a durable call state. Failed or stale work is retried; completed or
 * actively leased calls are harmless duplicates.
 */
export async function processCallScalerCall(payload: Record<string, any>): Promise<ProcessedCall> {
  const supabase = createAdminClient();
  const callId = String(payload.call_id ?? payload.id ?? '');
  if (!callId) throw new Error('CallScaler payload has no call_id');

  // Tracking-number allowlist (Admin → Integrations → CallScaler). When the
  // admin lists specific numbers, only INCOMING calls that arrived on one of
  // them are imported — every other call is dropped here, before it touches the
  // calls table or creates a contact. A blank list imports all calls (the
  // unchanged default). Both ingestion paths — the post-call webhook and the
  // cron backfill — reach this function, so this one gate covers them both.
  const { allowed_tracking_numbers } = await getSetting<{ allowed_tracking_numbers?: string }>(
    'callscaler'
  );
  const allowedNumbers = parseAllowedNumbers(allowed_tracking_numbers);
  if (allowedNumbers.size > 0) {
    const isOutbound = payload.direction === 'outbound';
    if (isOutbound || !isTrackingNumberAllowed(payload.tracking_number, allowedNumbers)) {
      return { callId, duplicate: false, skipped: 'number_not_allowed' };
    }
  }

  const { error: insertError } = await supabase.from('calls').upsert(
    {
      call_id: callId,
      ...callFields(payload),
      processing_status: 'pending',
    },
    { onConflict: 'call_id', ignoreDuplicates: true }
  );
  if (insertError) throw new Error(insertError.message);

  const { data: claimed, error: claimError } = await supabase
    .rpc('claim_call_processing', { p_call_id: callId, p_lease_seconds: 180 })
    .maybeSingle();
  if (claimError) throw new Error(claimError.message);
  if (!claimed) return { callId, duplicate: true };
  const claim = claimed as { id: string; contact_id: string | null };

  try {
    const { error: refreshError } = await supabase
      .from('calls')
      .update(callFields(payload))
      .eq('id', claim.id);
    if (refreshError) throw new Error(refreshError.message);

    if (SKIP_CATEGORIES.has(payload.ai_category)) {
      const { data: skipped, error: skipError } = await supabase
        .from('calls')
        .update({
          processing_status: 'completed',
          locked_at: null,
          processed_at: new Date().toISOString(),
        })
        .eq('id', claim.id)
        .eq('processing_status', 'processing')
        .select('id')
        .maybeSingle();
      if (skipError || !skipped) {
        throw new Error(skipError?.message ?? 'Call processing lease was lost');
      }
      return { callId, duplicate: false, skipped: payload.ai_category };
    }

    let contactId = claim.contact_id;
    let createdContact = false;
    if (!contactId) {
      const existing = await findMatchingContact(payload);
      if (existing) {
        contactId = existing.id;
        if (!existing.phone && payload.caller_number) {
          const { error } = await supabase
            .from('contacts')
            .update({ phone: payload.caller_number })
            .eq('id', contactId);
          if (error) throw new Error(error.message);
        }
      } else {
        const humanName = looksLikeHumanName(payload.caller_name);
        const { data: newStatus } = await supabase
          .from('statuses')
          .select('id')
          .eq('name', 'New')
          .maybeSingle();
        const { data: contact, error } = await supabase
          .from('contacts')
          .insert({
            name: humanName ? payload.caller_name.trim() : `Caller ${payload.caller_number ?? callId}`,
            // A real caller-ID name is machine-supplied, not human-entered — mark
            // it so the UI shows the green "verify me" phone marker. Cleared the
            // moment someone edits the name (clear_name_source_on_rename trigger).
            name_source: humanName ? 'callscaler' : null,
            phone: payload.caller_number ?? null,
            status_id: newStatus?.id ?? null,
            source: payload.utm_source ?? payload.source ?? 'call',
            utm: payload.utm_campaign ?? payload.utm_medium ?? null,
            ppc_kw: payload.utm_term ?? null,
            source_url: payload.landing_page_url ?? null,
            gclid: payload.gclid ?? null,
          })
          .select('id')
          .single();
        if (error || !contact) throw new Error(error?.message ?? 'contact insert failed');
        contactId = contact.id;
        createdContact = true;
      }
      const { error: linkError } = await supabase
        .from('calls')
        .update({ contact_id: contactId })
        .eq('id', claim.id);
      if (linkError) throw new Error(linkError.message);
    }
    if (!contactId) throw new Error('Call processing did not resolve a contact');

    const aiNote = payload.ai_category
      ? `, AI: ${payload.ai_category}${payload.ai_score != null ? ` (${payload.ai_score})` : ''}`
      : '';
    await logActivity({
      contactId,
      type: 'call',
      description: `${payload.direction === 'outbound' ? 'Outbound' : 'Inbound'} call, ${formatDuration(payload.duration_seconds)} — ${payload.status ?? 'completed'}${aiNote}${createdContact ? ' — new contact created from this call' : ''}`,
      meta: {
        call_id: callId,
        recording_url: payload.recording_url ?? null,
        qualified_ai: payload.qualified_ai ?? null,
      },
    });

    const namedNewContact = createdContact && looksLikeHumanName(payload.caller_name);
    const { error: completeError } = await supabase.rpc('complete_call_processing', {
      p_call_row_id: claim.id,
      p_call_id: callId,
      p_contact_id: contactId,
      // The reverse phone lookup is now an admin-only action (the "Reverse #
      // lookup" button), never automatic — a new call contact no longer spends a
      // billed Trestle lookup on its own. A real name and city/state are filled
      // only when an admin runs it by hand.
      p_enqueue_enrichment: false,
      p_enqueue_search: namedNewContact,
    });
    if (completeError) throw new Error(completeError.message);

    return {
      callId,
      duplicate: false,
      contactId,
      createdContact,
      searchContactId: namedNewContact ? contactId : undefined,
    };
  } catch (failure) {
    const { error: failureError } = await supabase
      .from('calls')
      .update({
        processing_status: 'failed',
        locked_at: null,
        last_error: errorMessage(failure).slice(0, 2000),
      })
      .eq('id', claim.id);
    if (failureError) {
      await logDebug({
        level: 'error',
        source: 'callscaler:processing-state',
        message: `Could not record failed call processing: ${failureError.message}`,
        context: { call_id: callId, original_error: errorMessage(failure) },
      });
    }
    throw failure;
  }
}

/**
 * Processes one small page per tick. A persisted API cursor resumes subsequent
 * pages; the updated_since high-water mark moves only after a page succeeds.
 */
export async function syncMissedCalls() {
  const cfg = await getSetting<{ api_key?: string }>('callscaler');
  if (!cfg.api_key) return { skipped: 'no api key' };

  const state = await getSetting<{
    updated_since?: string;
    cursor?: string | null;
    window_since?: string;
    sync_started_at?: string;
  }>('callscaler_sync', { fresh: true });
  const since =
    state.window_since ??
    state.updated_since ??
    new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const syncStartedAt = state.sync_started_at ?? new Date().toISOString();
  const params = new URLSearchParams({
    updated_since: since,
    limit: '25',
    include: 'transcription,summary',
  });
  if (state.cursor) params.set('cursor', state.cursor);

  const response = await fetch(`${API_BASE}/calls?${params}`, {
    headers: { Authorization: `Bearer ${cfg.api_key}` },
    signal: AbortSignal.timeout(20_000),
  });
  const bodyText = await readResponseText(response, 2 * 1024 * 1024);
  if (!response.ok) {
    throw new Error(`CallScaler Calls API failed: ${response.status} ${bodyText.slice(0, 300)}`);
  }

  let raw: any;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    throw new Error(`CallScaler Calls API returned non-JSON: ${bodyText.slice(0, 200)}`);
  }
  const page = parseCallScalerPage(raw);
  let processed = 0;
  let created = 0;
  let failed = 0;
  for (const call of page.calls) {
    try {
      const result = await processCallScalerCall(call);
      if (!result.duplicate) {
        processed += 1;
        if (result.createdContact) created += 1;
      }
    } catch (failure) {
      failed += 1;
      await logDebug({
        source: 'callscaler:sync',
        message: errorMessage(failure),
        context: { call_id: call?.call_id ?? call?.id ?? null },
      });
    }
  }
  if (failed) throw new Error(`CallScaler sync left ${failed} call(s) pending retry`);

  if (page.hasMore) {
    if (!page.nextCursor) throw new Error('CallScaler response has_more=true without next_cursor');
    await setSetting('callscaler_sync', {
      updated_since: state.updated_since ?? since,
      window_since: since,
      sync_started_at: syncStartedAt,
      cursor: page.nextCursor,
    });
  } else {
    await setSetting('callscaler_sync', {
      updated_since: syncStartedAt,
      window_since: null,
      sync_started_at: null,
      cursor: null,
    });
  }
  return { fetched: page.calls.length, processed, created, has_more: page.hasMore };
}
