import nodemailer from 'nodemailer';
import { createAdminClient } from '@/lib/supabase/server';
import { sendViaEmailit } from '@/lib/integrations/emailit';
import { getSetting } from '@/lib/settings';
import { logActivity } from '@/lib/activity';
import { signTrackingOpen, signTrackingUrl } from '@/lib/signing';
import { appBaseUrl } from '@/lib/app-url';
import { errorMessage, logDebug } from '@/lib/debug-log';
import { sanitizeEmailHtml } from '@/lib/html-sanitize';
import { markEmailAssetsReferenced } from '@/lib/email-assets';
import { resolvePublicMailTarget } from '@/lib/imap-target';

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
  deliveryKey?: string | null;
  appendToSent?: boolean; // interactive 1:1 sends: append a copy to the IMAP Sent folder
}): Promise<{ ok: boolean; messageRowId: string; error?: string; duplicate?: boolean }> {
  const supabase = createAdminClient();
  // Stored templates and sequence steps can be changed outside the rich-editor
  // UI. Sanitize at the final delivery boundary so every transport gets the
  // same safe body regardless of how it was authored.
  const cleanHtml = sanitizeEmailHtml(String(opts.html ?? '').slice(0, 750_000));
  await markEmailAssetsReferenced(supabase, cleanHtml);

  let account: any = null;
  if (opts.accountId) {
    const { data, error } = await supabase
      .from('email_accounts')
      .select('*')
      .eq('id', opts.accountId)
      .maybeSingle();
    if (error) throw new Error(`Could not load SMTP account: ${error.message}`);
    account = data;
  }
  // Only trusted background jobs may fall back to a service-role lookup of
  // the global default. User-triggered routes resolve an RLS-visible account
  // before calling this function and otherwise fall back to Emailit.
  if (!account && opts.actorId == null) {
    const { data, error } = await supabase
      .from('email_accounts')
      .select('*')
      .eq('is_default', true)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Could not load default SMTP account: ${error.message}`);
    account = data;
  }

  const fromEmail = account?.from_email ?? 'via Emailit';

  // #2: replies should land in the CRM inbox, not the raw From mailbox — point
  // them at the Emailit-inbound reply address (Admin → Integrations) when set,
  // on both the SMTP and Emailit paths below.
  const { inbound_reply_address: inboundReplyAddress } = await getSetting<{
    inbound_reply_address?: string;
  }>('emailit');
  const replyTo = inboundReplyAddress || undefined;

  // Create the message row first so we have an id for the tracking URLs.
  let { data: row, error: rowErr } = await supabase
    .from('email_messages')
    .insert({
      contact_id: opts.contactId ?? null,
      account_id: account?.id ?? null,
      direction: 'outbound',
      from_email: fromEmail,
      to_email: opts.to,
      subject: opts.subject,
      html: cleanHtml,
      sequence_id: opts.sequenceId ?? null,
      sequence_step_id: opts.sequenceStepId ?? null,
      status: 'queued',
      delivery_key: opts.deliveryKey ?? null,
    })
    .select('id')
    .single();
  if (rowErr?.code === '23505' && opts.deliveryKey) {
    const { data: existing } = await supabase
      .from('email_messages')
      .select('id, status, error')
      .eq('delivery_key', opts.deliveryKey)
      .maybeSingle();
    if (existing?.status === 'sent' || existing?.status === 'queued') {
      return {
        ok: existing.status === 'sent',
        messageRowId: existing.id,
        error: existing.status === 'queued' ? 'delivery already reserved' : undefined,
        duplicate: true,
      };
    }
    if (existing?.status === 'failed') {
      const retry = await supabase
        .from('email_messages')
        .update({ status: 'queued', error: null })
        .eq('id', existing.id)
        .eq('status', 'failed')
        .select('id')
        .maybeSingle();
      row = retry.data;
      rowErr = retry.error;
    }
  }
  if (rowErr || !row) return { ok: false, messageRowId: '', error: rowErr?.message ?? 'insert failed' };

  const appUrl = appBaseUrl();
  const signature =
    opts.appendSignature !== false && account?.signature_html
      ? `<br/><br/>${sanitizeEmailHtml(String(account.signature_html).slice(0, 100_000))}`
      : '';

  // The two transports are instrumented differently, so they get two bodies:
  //
  //  - SMTP: WE instrument it. Every http(s) link is routed through
  //    /api/track/click (the &s= HMAC pins the redirect to URLs this app
  //    actually sent, so it can't be abused as an open redirect) and an open
  //    pixel is appended. Emailit is not in the loop for an SMTP send, so this
  //    is the only way it gets tracked.
  //
  //  - Emailit: EMAILIT instruments it natively (sendViaEmailit passes
  //    tracking={loads,clicks} + meta.message_row_id) and reports opens/clicks
  //    via the email.loaded / email.clicked webhooks. Its body must therefore
  //    carry NEITHER our pixel NOR our rewritten links, or every open and click
  //    would be counted twice (once by us, once by Emailit).
  const smtpHtml =
    cleanHtml.replace(
      /href="(https?:\/\/[^"]+)"/gi,
      (_m, url) =>
        `href="${appUrl}/api/track/click?m=${row.id}&u=${encodeURIComponent(url)}&s=${signTrackingUrl(row.id, url)}"`
    ) +
    signature +
    `<img src="${appUrl}/api/track/open?m=${row.id}&s=${signTrackingOpen(row.id)}" width="1" height="1" alt="" style="display:none"/>`;
  const emailitHtml = cleanHtml + signature;

  let ok = false;
  let error: string | undefined;
  let messageId: string | undefined;
  let providerMessageId: string | undefined;
  let provider: 'smtp' | 'emailit' | null = null;

  // Try the account's SMTP first, when one is configured.
  if (account?.smtp_host) {
    provider = 'smtp';
    try {
      const target = await resolvePublicMailTarget(
        String(account.smtp_host),
        Number(account.smtp_port),
        'smtp'
      );
      // TLS mode follows the port, so an implicit-TLS ("secure on connect")
      // handshake is never attempted against a STARTTLS port — the classic
      // `tls_validate_record_header: wrong version number` failure. 465 is
      // implicit TLS; 587 and 25 are STARTTLS. A non-standard port falls back to
      // the account's stored flag.
      const smtpSecure =
        account.smtp_port === 465
          ? true
          : account.smtp_port === 587 || account.smtp_port === 25
            ? false
            : !!account.smtp_secure;
      const transport = nodemailer.createTransport({
        host: target.address,
        port: account.smtp_port,
        secure: smtpSecure,
        requireTLS: !smtpSecure, // STARTTLS ports must still upgrade, never send cleartext
        auth: { user: account.smtp_username, pass: account.smtp_password },
        tls: target.servername ? { servername: target.servername } : undefined,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
      });
      const info = await transport.sendMail({
        from: account.from_name ? `"${account.from_name}" <${account.from_email}>` : account.from_email,
        to: opts.to,
        subject: opts.subject,
        html: smtpHtml,
        ...(replyTo ? { replyTo } : {}),
      });
      messageId = info.messageId;
      ok = true;
    } catch (e: any) {
      error = e.message;
    }
  }

  // Emailit is the FALLBACK: reached when there is no SMTP account, OR when the
  // SMTP send above failed. Previously this was an either/or — Emailit was used
  // only when no SMTP account existed — so an SMTP failure never fell back,
  // contradicting the documented behaviour.
  if (!ok) {
    const smtpError = provider === 'smtp' ? error : undefined;
    if (smtpError) {
      await logDebug({
        level: 'warn',
        source: 'email-send:fallback',
        message: `SMTP send failed, falling back to Emailit: ${smtpError}`,
        context: { to: opts.to, account: account?.name ?? null },
        contactId: opts.contactId ?? null,
      }).catch(() => {});
    }
    // Stable idempotency key = the message row id, so a retried delivery that
    // already reached Emailit is deduped provider-side (finding #9). messageRowId
    // turns on Emailit's native open/click tracking and stamps the row id as
    // meta, so its engagement webhooks map back to this exact message.
    const r = await sendViaEmailit({
      to: opts.to,
      subject: opts.subject,
      html: emailitHtml,
      replyTo,
      idempotencyKey: row.id,
      messageRowId: row.id,
    });
    provider = 'emailit';
    ok = r.ok;
    providerMessageId = r.providerMessageId;
    // If SMTP also failed, surface both reasons.
    error = r.ok ? undefined : [smtpError, r.error].filter(Boolean).join(' → ');
  }

  const { error: statusError } = await supabase
    .from('email_messages')
    .update({
      status: ok ? 'sent' : 'failed',
      error: error ?? null,
      message_id: messageId ?? null,
      provider_message_id: providerMessageId ?? null,
      sent_at: ok ? new Date().toISOString() : null,
    })
    .eq('id', row.id);
  if (statusError) {
    await logDebug({
      level: 'error',
      source: 'email-send:ledger',
      message: `Provider result could not be recorded: ${statusError.message}`,
      context: { email_message_id: row.id, delivery_key: opts.deliveryKey ?? null, ok },
      contactId: opts.contactId ?? null,
    }).catch(() => {});
    return {
      ok: false,
      messageRowId: row.id,
      error: `Email provider result could not be recorded: ${statusError.message}`,
    };
  }

  // Mirror interactive sends into the mailbox's Sent folder so Thunderbird / mobile
  // show them. Bulk list + sequence sends don't set appendToSent, so Sent stays clean.
  if (ok && opts.appendToSent && account?.imap_enabled) {
    try {
      const { enqueueImapAppendSent } = await import('@/lib/integrations/imap-sync');
      await enqueueImapAppendSent(row.id);
    } catch (appendError) {
      // Non-fatal (the email was already sent), but not silent: a failed enqueue
      // means the copy won't reach Sent, which is worth seeing in the debug log.
      await logDebug({
        level: 'warn',
        source: 'email-send:append-sent',
        message: `Could not queue Sent-folder copy for ${row.id}: ${errorMessage(appendError)}`,
        contactId: opts.contactId ?? null,
      }).catch(() => {});
    }
  }

  if (!ok) {
    await logDebug({
      source: provider === 'smtp' ? 'email-send:smtp' : 'email-send:emailit',
      message: error ?? 'Email delivery failed',
      context: {
        to: opts.to,
        subject: opts.subject,
        account: account?.name ?? null,
        smtp_host: account?.smtp_host ?? null,
        sequence_id: opts.sequenceId ?? null,
      },
      contactId: opts.contactId ?? null,
    });
  }

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
