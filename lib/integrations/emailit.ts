import { getSetting } from '@/lib/settings';

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
    return { ok: false, error: `Emailit request failed: ${res.status} ${await res.text()}` };
  }
  return { ok: true };
}
