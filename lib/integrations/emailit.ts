import { getSetting } from '@/lib/settings';
import { readResponseText } from '@/lib/request-limits';

/**
 * Sends a transactional email via the Emailit API (v1).
 * Docs: https://emailit.com/docs
 * Used as the fallback sender when no SMTP account is selected, and for
 * system notifications (client alerts, countdown reminders).
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

  const res = await fetch('https://api.emailit.com/v1/emails', {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${cfg.api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${fromName} <${fromAddress}>`,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
    }),
  });

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
