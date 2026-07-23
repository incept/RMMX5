import nodemailer from 'nodemailer';
import { createAdminClient } from '@/lib/supabase/server';
import { sendViaEmailit } from '@/lib/integrations/emailit';
import { logActivity } from '@/lib/activity';

/**
 * Central outbound email path. Every CRM email (compose, sequence step,
 * campaign blast) goes through here so it is:
 *   1. recorded in email_messages (unified inbox + analytics),
 *   2. instrumented with an open-tracking pixel and click-tracked links,
 *   3. signed with the sending account's signature,
 *   4. delivered via the account's SMTP (nodemailer) or Emailit as fallback.
 */
export async function sendCrmEmail(opts: {
  to: string;
  subject: string;
  html: string;
  accountId?: string | null;
  contactId?: string | null;
  sequenceId?: string | null;
  sequenceStepId?: string | null;
  actorId?: string | null;
  appendSignature?: boolean; // default true
}): Promise<{ ok: boolean; messageRowId: string; error?: string }> {
  const supabase = createAdminClient();

  let account: any = null;
  if (opts.accountId) {
    const { data } = await supabase
      .from('email_accounts')
      .select('*')
      .eq('id', opts.accountId)
      .maybeSingle();
    account = data;
  }
  if (!account) {
    const { data } = await supabase
      .from('email_accounts')
      .select('*')
      .eq('is_default', true)
      .limit(1)
      .maybeSingle();
    account = data;
  }

  const fromEmail = account?.from_email ?? 'via Emailit';

  // Create the message row first so we have an id for the tracking URLs.
  const { data: row, error: rowErr } = await supabase
    .from('email_messages')
    .insert({
      contact_id: opts.contactId ?? null,
      account_id: account?.id ?? null,
      direction: 'outbound',
      from_email: fromEmail,
      to_email: opts.to,
      subject: opts.subject,
      html: opts.html,
      sequence_id: opts.sequenceId ?? null,
      sequence_step_id: opts.sequenceStepId ?? null,
      status: 'queued',
    })
    .select('id')
    .single();
  if (rowErr || !row) return { ok: false, messageRowId: '', error: rowErr?.message ?? 'insert failed' };

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');

  // Click tracking: route every http(s) link through /api/track/click.
  let html = opts.html.replace(
    /href="(https?:\/\/[^"]+)"/gi,
    (_m, url) => `href="${appUrl}/api/track/click?m=${row.id}&u=${encodeURIComponent(url)}"`
  );

  if (opts.appendSignature !== false && account?.signature_html) {
    html += `<br/><br/>${account.signature_html}`;
  }

  // Open tracking pixel.
  html += `<img src="${appUrl}/api/track/open?m=${row.id}" width="1" height="1" alt="" style="display:none"/>`;

  let ok = false;
  let error: string | undefined;
  let messageId: string | undefined;

  try {
    if (account?.smtp_host) {
      const transport = nodemailer.createTransport({
        host: account.smtp_host,
        port: account.smtp_port,
        secure: !!account.smtp_secure,
        auth: { user: account.smtp_username, pass: account.smtp_password },
      });
      const info = await transport.sendMail({
        from: account.from_name ? `"${account.from_name}" <${account.from_email}>` : account.from_email,
        to: opts.to,
        subject: opts.subject,
        html,
      });
      messageId = info.messageId;
      ok = true;
    } else {
      const r = await sendViaEmailit({ to: opts.to, subject: opts.subject, html });
      ok = r.ok;
      error = r.error;
    }
  } catch (e: any) {
    error = e.message;
  }

  await supabase
    .from('email_messages')
    .update({
      status: ok ? 'sent' : 'failed',
      error: error ?? null,
      message_id: messageId ?? null,
      sent_at: ok ? new Date().toISOString() : null,
    })
    .eq('id', row.id);

  if (opts.contactId) {
    await logActivity({
      contactId: opts.contactId,
      actorId: opts.actorId ?? null,
      type: 'email',
      description: ok
        ? `Email sent: "${opts.subject}" → ${opts.to}`
        : `Email FAILED: "${opts.subject}" → ${opts.to} (${error})`,
      meta: { message_row_id: row.id, sequence_id: opts.sequenceId ?? null },
    });
  }

  return { ok, messageRowId: row.id, error };
}
