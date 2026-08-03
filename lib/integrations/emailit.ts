import { createAdminClient } from '@/lib/supabase/server';
import { getSetting } from '@/lib/settings';
import { readResponseText } from '@/lib/request-limits';

/**
 * Emailit caps requests at 2 per second (429 rate_limit_exceeded above that). A
 * drained delivery batch sends many emails back-to-back, which bursts past that
 * cap, so every Emailit send goes through one serialized gate that spaces calls
 * >= EMAILIT_MIN_INTERVAL_MS apart — 1 send per 2s, well under the limit.
 *
 * The gate has two layers: an in-process promise chain (so one process never
 * fires concurrent reservations) plus a DB-coordinated slot (finding #9). The
 * old gate was process-local, so several app processes could each send in the
 * same second and still trip the cap; claim_provider_send_slot is a shared clock
 * every process reserves against. If that RPC is unavailable the gate falls back
 * to in-process spacing, so a database hiccup can never block mail entirely.
 */
const EMAILIT_MIN_INTERVAL_MS = 2000;
let emailitGate: Promise<unknown> = Promise.resolve();
let lastEmailitSendAt = 0;

async function reserveEmailitSlotMs(): Promise<number> {
  try {
    const { data, error } = await createAdminClient().rpc('claim_provider_send_slot', {
      p_provider: 'emailit',
      p_min_interval_ms: EMAILIT_MIN_INTERVAL_MS,
    });
    if (error || !data) throw new Error(error?.message ?? 'no send slot returned');
    return new Date(data as string).getTime() - Date.now();
  } catch {
    // Local fallback: space sends within this process if the shared gate is down.
    return lastEmailitSendAt + EMAILIT_MIN_INTERVAL_MS - Date.now();
  }
}

function throttleEmailit<T>(fn: () => Promise<T>): Promise<T> {
  const run = emailitGate.then(async () => {
    const wait = await reserveEmailitSlotMs();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastEmailitSendAt = Date.now();
    return fn();
  });
  // Keep the chain alive across individual failures so one bad send can't wedge
  // every later one.
  emailitGate = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Sends a transactional email via the Emailit API (v2).
 * Docs: https://emailit.com/docs
 * Used as the fallback sender when no SMTP account is selected, and for
 * system notifications (client alerts, countdown reminders).
 *
 * Rate-limited to 1 send / 2s (see throttleEmailit) so a drained delivery batch
 * cannot trip Emailit's 2/sec cap.
 */
export async function sendViaEmailit(opts: {
  to: string;
  subject: string;
  html: string;
  fromName?: string;
  replyTo?: string;
  idempotencyKey?: string;
  // The email_messages row this send belongs to. When present, Emailit's native
  // open/click tracking is enabled for this send and the row id is attached as
  // meta, so the email.loaded / email.clicked webhooks map straight back to it
  // (see app/api/webhooks/emailit). Omitted for system notifications, which have
  // no email_messages row and are not engagement-tracked.
  messageRowId?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getSetting<{
    api_key?: string;
    from_address?: string;
    from_name?: string;
    inbound_reply_address?: string;
  }>('emailit');
  if (!cfg.api_key) return { ok: false, error: 'Emailit is not configured (Admin → Integrations).' };

  const fromAddress = cfg.from_address || 'alerts@example.com';
  const fromName = opts.fromName || cfg.from_name || 'RMMX5';
  // #2: default replies to the Emailit-inbound address so they route back into
  // the CRM inbox instead of the raw From mailbox (an explicit replyTo wins).
  const replyTo = opts.replyTo || cfg.inbound_reply_address || undefined;
  const body = JSON.stringify({
    from: `${fromName} <${fromAddress}>`,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    ...(replyTo ? { reply_to: replyTo } : {}),
    // Enable Emailit's native open/click tracking for CRM mail and stamp the
    // row id so its webhooks are unambiguously attributable. `tracking` is a
    // per-send override of the domain default (loads = opens, clicks = clicks),
    // so this works without touching the Emailit domain settings. `meta` is
    // echoed back verbatim on every event as email.meta.
    ...(opts.messageRowId
      ? {
          tracking: { loads: true, clicks: true },
          meta: { message_row_id: opts.messageRowId },
        }
      : {}),
  });

  // #9: send on v2 with an Idempotency-Key when the caller supplies a stable id
  // (the email_messages row id, a notification id). Emailit dedupes a repeated
  // key for 24h, so a job retry that already delivered cannot send a second copy.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.api_key}`,
    'Content-Type': 'application/json',
  };
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  const send = () =>
    throttleEmailit(() =>
      fetch('https://api.emailit.com/v2/emails', {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers,
        body,
      })
    );

  let res = await send();
  // If a 429 still slips through (e.g. a second process sending in parallel),
  // drain the body and retry once. The throttle already spaces the retry >= 2s,
  // which clears the per-second window instead of failing the whole job.
  if (res.status === 429) {
    await readResponseText(res, 4096).catch(() => '');
    res = await send();
  }

  if (!res.ok) {
    const detail = await readResponseText(res, 64 * 1024);
    return { ok: false, error: `Emailit request failed: ${res.status} ${detail.slice(0, 500)}` };
  }
  return { ok: true };
}

export type EmailitBody = { html: string; text: string };

/**
 * Fetches only the text + HTML body of a received message from Emailit's
 * dedicated body endpoint (GET /v2/emails/{id}/body → { text, html }).
 *
 * The full GET /v2/emails/{id} returns attachments inline as base64, which can
 * push even a modest message past our 1 MiB response cap and fail the webhook
 * (finding #1). The sender / recipient / subject we need come from the webhook's
 * own data.object, so the body is all we fetch here.
 * Docs: https://emailit.com/docs/api-reference/emails/get/
 */
export async function fetchEmailitBody(
  id: string
): Promise<{ ok: true; body: EmailitBody } | { ok: false; error: string }> {
  const cfg = await getSetting<{ api_key?: string }>('emailit');
  if (!cfg.api_key) return { ok: false, error: 'Emailit is not configured (Admin → Integrations).' };
  // The id arrives on a signature-verified webhook, but constrain it to the
  // known token shape so it can never reshape the request URL (path traversal).
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return { ok: false, error: 'Invalid Emailit email id' };

  let res: Response;
  try {
    res = await fetch(`https://api.emailit.com/v2/emails/${id}/body`, {
      method: 'GET',
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${cfg.api_key}`, Accept: 'application/json' },
    });
  } catch (e: any) {
    return { ok: false, error: `Emailit get-body request failed: ${e?.message ?? 'network error'}` };
  }

  const bodyText = await readResponseText(res, 1024 * 1024);
  if (!res.ok) {
    return { ok: false, error: `Emailit get-body failed: ${res.status} ${bodyText.slice(0, 300)}` };
  }
  let data: any;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return { ok: false, error: 'Emailit get-body returned a non-JSON body' };
  }
  return {
    ok: true,
    body: {
      html: typeof data?.html === 'string' ? data.html : '',
      text: typeof data?.text === 'string' ? data.text : '',
    },
  };
}
