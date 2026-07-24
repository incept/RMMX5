import { createAdminClient } from '@/lib/supabase/server';
import { getSetting, setSetting } from '@/lib/settings';
import { logActivity } from '@/lib/activity';
import { runAutoSearchForContact } from '@/lib/lead-intake';
import { logDebug, errorMessage } from '@/lib/debug-log';

/**
 * CallScaler integration (https://callscaler.com/docs).
 *
 * Two entry points feed the same processor:
 *   1. The post-call webhook (/api/webhooks/callscaler) — configure it per
 *      call flow with "Wait for AI" so the spam screen and transcript arrive
 *      in the same event.
 *   2. syncMissedCalls(), run from the cron tick — their webhook retries give
 *      up after ~2.5 minutes, so a call that lands mid-deploy would otherwise
 *      be lost. The Calls API's updated_since cursor backfills it.
 *
 * Idempotency is the calls table itself: call_id is unique and the row is
 * claimed with an ignore-duplicates upsert before any side effects, so the
 * webhook and the backfill can race safely.
 */

const API_BASE = 'https://callscaler.com/api/v1';

/** Categories that should never become contacts. */
const SKIP_CATEGORIES = new Set(['spam', 'wrong_number']);

export interface ProcessedCall {
  callId: string;
  duplicate: boolean;
  skipped?: string;
  contactId?: string;
  createdContact?: boolean;
  /** Set when a brand-new contact has a name worth auto-searching. */
  searchContactId?: string;
}

/** Last 10 digits — enough to match US numbers across +1/formatting variants. */
function phoneDigits(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : null;
}

/**
 * CNAM names are frequently carrier junk ("WIRELESS CALLER", "TOLL FREE") or
 * a business name — searching Google for those wastes BrightData credits and
 * fills link slots with garbage. Only a plausible person name qualifies.
 */
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
  const s = Math.max(0, Number(seconds) || 0);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/**
 * Matches a call to an existing contact. gclid first (same ad click = same
 * person, immune to CNAM junk), then phone digits. Contact volume is modest,
 * so the phone pass compares digits in JS rather than maintaining a
 * normalised-phone column.
 */
async function findMatchingContact(
  payload: Record<string, any>
): Promise<{ id: string; phone: string | null } | null> {
  const supabase = createAdminClient();

  if (payload.gclid) {
    const { data } = await supabase
      .from('contacts')
      .select('id, phone')
      .eq('gclid', payload.gclid)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }

  const digits = phoneDigits(payload.caller_number);
  if (!digits) return null;

  const { data: candidates } = await supabase
    .from('contacts')
    .select('id, phone, created_at')
    .not('phone', 'is', null)
    .order('created_at', { ascending: false })
    .limit(2000);

  return (candidates ?? []).find((c) => phoneDigits(c.phone) === digits) ?? null;
}

/**
 * Stores one call and creates/links its contact. Shared by the webhook and
 * the cron backfill. Never runs the auto search itself — the webhook must
 * answer within CallScaler's 10-second window, so the caller decides whether
 * to run it inline (cron) or deferred (webhook, via next/server `after`).
 */
export async function processCallScalerCall(payload: Record<string, any>): Promise<ProcessedCall> {
  const supabase = createAdminClient();
  const callId = String(payload.call_id ?? payload.id ?? '');
  if (!callId) throw new Error('CallScaler payload has no call_id');

  // Claim the call row first: ignoreDuplicates makes the unique call_id the
  // idempotency lock, so a webhook retry or a concurrent backfill no-ops here.
  const { data: claimed, error: claimError } = await supabase
    .from('calls')
    .upsert(
      {
        call_id: callId,
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
        raw: payload,
        started_at: payload.created_at ? new Date(payload.created_at).toISOString() : null,
      },
      { onConflict: 'call_id', ignoreDuplicates: true }
    )
    .select('id')
    .maybeSingle();
  if (claimError) throw new Error(claimError.message);
  if (!claimed) return { callId, duplicate: true };

  try {
    // Spam and wrong numbers keep their call row (visible history, and the
    // backfill won't reprocess them) but never become contacts.
    if (SKIP_CATEGORIES.has(payload.ai_category)) {
      await logDebug({
        level: 'info',
        source: 'callscaler',
        message: `Call ${callId} stored without a contact (AI: ${payload.ai_category})`,
        context: { caller_number: payload.caller_number, ai_score: payload.ai_score },
      });
      return { callId, duplicate: false, skipped: payload.ai_category };
    }

    const existing = await findMatchingContact(payload);
    let contactId: string;
    let createdContact = false;

    if (existing) {
      contactId = existing.id;
      // A form lead calling in often supplies the phone number the form never
      // collected — backfill it, but never overwrite one already on file.
      if (!existing.phone && payload.caller_number) {
        await supabase.from('contacts').update({ phone: payload.caller_number }).eq('id', contactId);
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

    await supabase.from('calls').update({ contact_id: contactId }).eq('id', claimed.id);

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

    return {
      callId,
      duplicate: false,
      contactId,
      createdContact,
      // Only fresh contacts with a real person name are worth a Google search;
      // matched contacts were already searched on their original intake.
      searchContactId:
        createdContact && looksLikeHumanName(payload.caller_name) ? contactId : undefined,
    };
  } catch (e) {
    // Release the claim so CallScaler's retry (or the next backfill) can
    // reprocess instead of finding a half-finished row and skipping forever.
    await supabase.from('calls').delete().eq('id', claimed.id);
    throw e;
  }
}

/** Best-effort auto search — a BrightData hiccup must never fail call intake. */
export async function runCallSearch(contactId: string) {
  try {
    await runAutoSearchForContact(contactId);
  } catch (e) {
    await logActivity({
      contactId,
      type: 'search',
      description: `Auto search skipped: ${errorMessage(e)}`,
    });
    await logDebug({
      source: 'callscaler:auto-search',
      message: errorMessage(e),
      contactId,
    });
  }
}

/**
 * Cron-tick safety net: pulls calls updated since the last sync and runs any
 * the webhook never delivered through the same processor. Sync state lives
 * under its own settings key so saving the admin form (key "callscaler")
 * cannot wipe the cursor.
 */
export async function syncMissedCalls() {
  const cfg = await getSetting<{ api_key?: string }>('callscaler');
  if (!cfg.api_key) return { skipped: 'no api key' };

  const state = await getSetting<{ updated_since?: string }>('callscaler_sync');
  // First run looks back 24h; after that, from the last successful sync.
  const since = state.updated_since ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const syncStartedAt = new Date().toISOString();

  const res = await fetch(
    `${API_BASE}/calls?updated_since=${encodeURIComponent(since)}&limit=200`,
    {
      headers: { Authorization: `Bearer ${cfg.api_key}` },
      signal: AbortSignal.timeout(30_000),
    }
  );
  const bodyText = await res.text();
  if (!res.ok) {
    await logDebug({
      source: 'callscaler:sync',
      message: `Calls API returned HTTP ${res.status}`,
      context: { response: bodyText.slice(0, 300) },
    });
    throw new Error(`CallScaler Calls API failed: ${res.status}`);
  }

  let data: any;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(`CallScaler Calls API returned non-JSON: ${bodyText.slice(0, 200)}`);
  }
  const calls: any[] = data?.calls ?? data?.data ?? (Array.isArray(data) ? data : []);

  let processed = 0;
  let created = 0;
  for (const call of calls) {
    try {
      const result = await processCallScalerCall(call);
      if (!result.duplicate) {
        processed += 1;
        if (result.createdContact) created += 1;
        // Cron has no 10-second deadline, so the search can run inline.
        if (result.searchContactId) await runCallSearch(result.searchContactId);
      }
    } catch (e) {
      await logDebug({
        source: 'callscaler:sync',
        message: errorMessage(e),
        context: { call_id: call?.call_id ?? call?.id ?? null },
      });
    }
  }

  await setSetting('callscaler_sync', { updated_since: syncStartedAt });
  return { fetched: calls.length, processed, created };
}
