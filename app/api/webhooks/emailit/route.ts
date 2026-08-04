import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/server';
import { getSetting } from '@/lib/settings';
import { stopEnrollmentsFor } from '@/lib/sequence-runner';
import { logActivity } from '@/lib/activity';
import { logDebug } from '@/lib/debug-log';
import { verifyEmailitWebhook } from '@/lib/webhook-auth';
import { claimWebhookReceipt, releaseWebhookReceipt } from '@/lib/webhook-receipts';
import { readTextBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import { fetchEmailitBody } from '@/lib/integrations/emailit';
import { recordInboundEmail } from '@/lib/inbound-email';

/**
 * Emailit event webhook (bounces & complaints) — configure in the Emailit
 * dashboard to POST here: /api/webhooks/emailit. Emailit's timestamped
 * X-Emailit-Signature is verified over the raw request body.
 *
 * A hard bounce:
 *   * flags the contact's latest outbound message as bounced
 *   * stops sequences with a "bounce" stop trigger
 *   * flips the contact's status to "Bad Email" / "Bounced" if those exist
 *     (the email-removal alert: stop mailing dead addresses immediately)
 */
export async function POST(request: Request) {
  let rawBody: string;
  try {
    rawBody = await readTextBody(request, 1024 * 1024);
  } catch (error) {
    return apiFailure('api:webhooks/emailit', error);
  }
  const cfg = await getSetting<{ webhook_signing_secret?: string }>('emailit');
  if (
    !verifyEmailitWebhook(
      rawBody,
      request.headers.get('x-emailit-signature'),
      request.headers.get('x-emailit-timestamp'),
      cfg.webhook_signing_secret
    )
  ) {
    return NextResponse.json({ error: 'Invalid Emailit signature' }, { status: 401 });
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const eventType = String(body?.type ?? body?.event ?? '').toLowerCase();
  const payloadDigest = createHash('sha256').update(rawBody).digest('hex');

  // Inbound mail (Webhooks v2). The event carries only headers, so fetch the
  // full body by id and drop it into the unified inbox via the shared recorder.
  // De-duplicated on the event id, exactly like the bounce path below.
  if (eventType === 'email.received' || eventType.endsWith('.received')) {
    const object = body?.data?.object ?? {};
    const emailId = object?.id ?? body?.data?.id ?? body?.object?.id ?? body?.id ?? null;
    if (!emailId) return NextResponse.json({ ok: true, ignored: 'received: missing email id' });
    const receivedEventId = body?.event_id ?? body?.id ?? `emailit-received:${emailId}`;
    const claimedReceived = await claimWebhookReceipt('emailit', receivedEventId);
    if (!claimedReceived) return NextResponse.json({ ok: true, duplicate: true });
    try {
      // Headers (from/to/subject) come from the webhook's data.object; only the
      // body needs a fetch. The dedicated /body endpoint avoids the full
      // GET /emails/{id}, whose inline base64 attachments can push a modest
      // message past the response cap and fail this handler (finding #1).
      const fetched = await fetchEmailitBody(String(emailId));
      if (!fetched.ok) throw new Error(fetched.error);
      const { contactId } = await recordInboundEmail({
        from: String(object.from ?? ''),
        to: String(object.to ?? ''),
        subject: String(object.subject ?? ''),
        html: fetched.body.html,
        text: fetched.body.text,
        messageId: String(object.message_id ?? emailId),
        providerMessageId: String(emailId),
      });
      return NextResponse.json({ ok: true, contact_id: contactId });
    } catch (error: any) {
      await releaseWebhookReceipt('emailit', receivedEventId);
      return NextResponse.json({ error: error?.message ?? 'Inbound email failed' }, { status: 500 });
    }
  }

  // Native engagement tracking: Emailit's own open/click tracking, enabled
  // per-send in sendViaEmailit (tracking={loads,clicks}). email.loaded = open,
  // email.clicked = click. The email_messages row id rides back as
  // email.meta.message_row_id, so each event maps straight to its message;
  // the provider message id is the exact fallback when meta was omitted. This is
  // how EMAILIT-sent mail is tracked — SMTP-sent mail is tracked by the
  // /api/track pixel + redirect instead, so the two never double-count.
  const isOpen = eventType === 'email.loaded' || eventType.endsWith('.loaded');
  const isClick = eventType === 'email.clicked' || eventType.endsWith('.clicked');
  if (isOpen || isClick) {
    const object = body?.data?.object ?? {};
    const emailObj = object?.email ?? {};
    const engagementEventId =
      body?.event_id ?? object?.id ?? `emailit-${isClick ? 'click' : 'load'}:${payloadDigest}`;
    const claimedEngagement = await claimWebhookReceipt('emailit', engagementEventId);
    if (!claimedEngagement) return NextResponse.json({ ok: true, duplicate: true });
    try {
      const admin = createAdminClient();

      // Prefer the exact row id stamped in meta. The provider id returned by the
      // send API is a second exact key for events whose meta was omitted. Never
      // guess "latest outbound" from a recipient: a delayed event would then be
      // credited to the wrong message.
      let messageId: string | null =
        typeof emailObj?.meta?.message_row_id === 'string' ? emailObj.meta.message_row_id : null;
      if (messageId) {
        const { data: row, error } = await admin
          .from('email_messages')
          .select('id, contact_id')
          .eq('id', messageId)
          .maybeSingle();
        if (error) throw error;
        messageId = row?.id ?? null;
      }
      const providerMessageId =
        typeof emailObj?.id === 'string' && emailObj.id ? emailObj.id : null;
      if (!messageId && providerMessageId) {
        const { data: row, error } = await admin
          .from('email_messages')
          .select('id, contact_id')
          .eq('provider_message_id', providerMessageId)
          .maybeSingle();
        if (error) throw error;
        messageId = row?.id ?? null;
      }
      // No CRM message to attribute (e.g. a system-notification email). Keep the
      // claimed receipt so it isn't reprocessed, and move on.
      if (!messageId) return NextResponse.json({ ok: true, ignored: 'no matching message' });

      const clickedUrl =
        isClick && typeof object?.link?.url === 'string' ? object.link.url : null;
      // Same atomic, bucket-bounded counter the /api/track pixel uses, so an
      // Emailit-tracked open/click increments open_count/click_count and lands
      // in email_events identically to a self-tracked one.
      const { data: counted, error: trackingError } = await admin
        .rpc('track_email_event_and_stop', {
          p_message_id: messageId,
          p_event: isClick ? 'click' : 'open',
          p_url: clickedUrl,
          p_bucket_seconds: 60,
        })
        .maybeSingle<{ message_id: string; contact_id: string | null; counted: boolean }>();
      if (trackingError) throw trackingError;
      return NextResponse.json({ ok: true, counted: !!counted?.counted });
    } catch (error: any) {
      await releaseWebhookReceipt('emailit', engagementEventId);
      return NextResponse.json(
        { error: error?.message ?? 'Emailit engagement tracking failed' },
        { status: 500 }
      );
    }
  }

  if (!eventType.includes('bounce') && !eventType.includes('complaint')) {
    return NextResponse.json({ ok: true, ignored: eventType });
  }

  const recipientCandidate =
    body?.email ??
    body?.recipient ??
    body?.data?.email ??
    body?.data?.to ??
    body?.data?.object?.email?.rcpt_to ??
    body?.data?.object?.email?.to ??
    body?.data?.object?.to ??
    null;
  const recipientValue = Array.isArray(recipientCandidate)
    ? recipientCandidate[0]
    : recipientCandidate;
  const recipient =
    typeof recipientValue === 'object' ? recipientValue?.email ?? null : recipientValue;
  if (!recipient) return NextResponse.json({ ok: true, ignored: 'no recipient' });

  const eventId = body?.event_id ?? body?.id ?? `emailit-${eventType}:${payloadDigest}`;
  const claimed = await claimWebhookReceipt('emailit', eventId);
  if (!claimed) return NextResponse.json({ ok: true, duplicate: true });

  try {
    const admin = createAdminClient();
    const object = body?.data?.object ?? {};
    const emailObject = object?.email ?? object;
    const metaMessageId =
      typeof emailObject?.meta?.message_row_id === 'string'
        ? emailObject.meta.message_row_id
        : null;
    const providerMessageId =
      typeof emailObject?.id === 'string' && emailObject.id.startsWith('em_')
        ? emailObject.id
        : null;
    let messageQuery = admin
      .from('email_messages')
      .select('id, contact_id');
    if (metaMessageId) messageQuery = messageQuery.eq('id', metaMessageId);
    else if (providerMessageId) {
      messageQuery = messageQuery.eq('provider_message_id', providerMessageId);
    } else {
      await logDebug({
        level: 'warn',
        source: 'webhook:emailit',
        message: `Ignored ${eventType}: event had no exact CRM message identifier`,
        context: { event_id: eventId, recipient: String(recipient).slice(0, 320) },
      }).catch(() => {});
      return NextResponse.json({ ok: true, ignored: 'no exact message identifier' });
    }
    const messageResult = await messageQuery.maybeSingle();
    if (messageResult.error) throw messageResult.error;
    const lastOut = messageResult.data;
    if (!lastOut?.contact_id) {
      return NextResponse.json({ ok: true, ignored: 'no matching CRM message' });
    }

    const contactResult = await admin
      .from('contacts')
      .select('id, name, status_id')
      .eq('id', lastOut.contact_id)
      .maybeSingle();
    if (contactResult.error) throw contactResult.error;
    const contact = contactResult.data;
    if (!contact) return NextResponse.json({ ok: true, ignored: 'no matching contact' });

    const bounced = await admin.from('email_messages').update({ bounced: true }).eq('id', lastOut.id);
    if (bounced.error) throw bounced.error;
    const eventInsert = await admin.from('email_events').insert({
      message_id: lastOut.id,
      contact_id: contact.id,
      type: 'bounce',
      meta: { event: eventType, event_id: eventId },
    });
    if (eventInsert.error) throw eventInsert.error;

    await stopEnrollmentsFor(contact.id, 'bounce');

    // Auto-status: prefer "Bounced", fall back to "Bad Email".
    const { data: bounceStatus, error: statusReadError } = await admin
      .from('statuses')
      .select('id, name')
      .in('name', ['Bounced', 'Bad Email'])
      .order('name') // "Bad Email" sorts first; prefer Bounced below
      .limit(2);
    if (statusReadError) throw statusReadError;
    const target =
      bounceStatus?.find((s) => s.name === 'Bounced') ?? bounceStatus?.[0] ?? null;
    if (target && contact.status_id !== target.id) {
      const statusUpdate = await admin
        .from('contacts')
        .update({ status_id: target.id })
        .eq('id', contact.id);
      if (statusUpdate.error) throw statusUpdate.error;
    }

    await logActivity({
      contactId: contact.id,
      type: 'email',
      description: `Email ${eventType} for ${recipient} — sequences stopped${target ? `, status set to "${target.name}"` : ''}`,
    });

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    await releaseWebhookReceipt('emailit', eventId);
    return NextResponse.json({ error: error?.message ?? 'Emailit webhook failed' }, { status: 500 });
  }
}
