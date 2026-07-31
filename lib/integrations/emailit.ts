import { getSetting } from '@/lib/settings';
import { readResponseText } from '@/lib/request-limits';

/**
 * Emailit caps requests at 2 per second (429 rate_limit_exceeded above that). A
 * drained delivery batch sends many emails back-to-back in one process, which
 * bursts past that cap, so every Emailit send goes through one serialized gate
 * that spaces calls >= EMAILIT_MIN_INTERVAL_MS apart — 1 send per 2s, well under
 * the limit. The gate is per process, which is exactly where the burst is: the
 * queue drains its delivery batch sequentially in the cron tick.
 */
const EMAILIT_MIN_INTERVAL_MS = 2000;
let emailitGate: Promise<unknown> = Promise.resolve();
let lastEmailitSendAt = 0;

function throttleEmailit<T>(fn: () => Promise<T>): Promise<T> {
  const run = emailitGate.then(async () => {
    const wait = lastEmailitSendAt + EMAILIT_MIN_INTERVAL_MS - Date.now();
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
 * Sends a transactional email via the Emailit API (v1).
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
}): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getSetting<{ api_key?: string; from_address?: string; from_name?: string }>('emailit');
  if (!cfg.api_key) return { ok: false, error: 'Emailit is not configured (Admin → Integrations).' };

  const fromAddress = cfg.from_address || 'alerts@example.com';
  const fromName = opts.fromName || cfg.from_name || 'RMMX5';
  const body = JSON.stringify({
    from: `${fromName} <${fromAddress}>`,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
  });

  const send = () =>
    throttleEmailit(() =>
      fetch('https://api.emailit.com/v1/emails', {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${cfg.api_key}`,
          'Content-Type': 'application/json',
        },
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

export type EmailitMessage = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  messageId: string | null;
};

/**
 * Fetches one received message's full content by id — the `em_…` id Emailit
 * sends in an `email.received` webhook, which carries only headers, not the
 * body. Inbound lives on the v2 API (the send path above is v1); the body is
 * returned under body.html / body.text.
 */
export async function fetchEmailitMessage(
  id: string
): Promise<{ ok: true; message: EmailitMessage } | { ok: false; error: string }> {
  const cfg = await getSetting<{ api_key?: string }>('emailit');
  if (!cfg.api_key) return { ok: false, error: 'Emailit is not configured (Admin → Integrations).' };
  // The id arrives on a signature-verified webhook, but constrain it to the
  // known token shape so it can never reshape the request URL (path traversal).
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return { ok: false, error: 'Invalid Emailit email id' };

  let res: Response;
  try {
    res = await fetch(`https://api.emailit.com/v2/emails/${id}`, {
      method: 'GET',
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${cfg.api_key}`, Accept: 'application/json' },
    });
  } catch (e: any) {
    return { ok: false, error: `Emailit get-email request failed: ${e?.message ?? 'network error'}` };
  }

  const bodyText = await readResponseText(res, 1024 * 1024);
  if (!res.ok) {
    return { ok: false, error: `Emailit get-email failed: ${res.status} ${bodyText.slice(0, 300)}` };
  }
  let data: any;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return { ok: false, error: 'Emailit get-email returned a non-JSON body' };
  }
  return {
    ok: true,
    message: {
      from: String(data?.from ?? data?.headers?.From ?? data?.headers?.from ?? ''),
      to: String(data?.to ?? data?.headers?.To ?? data?.headers?.to ?? ''),
      subject: String(data?.subject ?? data?.headers?.Subject ?? data?.headers?.subject ?? ''),
      html: typeof data?.body?.html === 'string' ? data.body.html : '',
      text: typeof data?.body?.text === 'string' ? data.body.text : '',
      messageId: data?.message_id ? String(data.message_id) : null,
    },
  };
}
