import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getSetting } from '@/lib/settings';
import { stopEnrollmentsFor } from '@/lib/sequence-runner';
import { logActivity } from '@/lib/activity';
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
  // recipient is the fallback for mail sent before meta was attached. This is
  // how EMAILIT-sent mail is tracked — SMTP-sent mail is tracked by the
  // /api/track pixel + redirect instead, so the two never double-count.
  const isOpen = eventType === 'email.loaded' || eventType.endsWith('.loaded');
  const isClick = eventType === 'email.clicked' || eventType.endsWith('.clicked');
  if (isOpen || isClick) {
    const object = body?.data?.object ?? {};
    const emailObj = object?.email ?? {};
    const engagementEventId =
      body?.event_id ?? object?.id ?? `emailit-${isClick ? 'click' : 'load'}:${emailObj?.id ?? ''}`;
    const claimedEngagement = await claimWebhookReceipt('emailit', engagementEventId);
    if (!claimedEngagement) return NextResponse.json({ ok: true, duplicate: true });
    try {
      const admin = createAdminClient();

      // Prefer the exact row id we stamped as meta; fall back to recipient ->
      // latest outbound (older mail, or a recipient with no meta).
      let messageId: string | null =
        typeof emailObj?.meta?.message_row_id === 'string' ? emailObj.meta.message_row_id : null;
      let contactId: string | null = null;
      if (messageId) {
        const { data: row } = await admin
          .from('email_messages')
          .select('id, contact_id')
          .eq('id', messageId)
          .maybeSingle();
        messageId = row?.id ?? null;
        contactId = row?.contact_id ?? null;
      }
      if (!messageId) {
        const rcpt = emailObj?.rcpt_to ?? object?.rcpt_to ?? null;
        if (rcpt) {
          const { data: contact } = await admin
            .from('contacts')
            .select('id')
            .ilike('email', String(rcpt))
            .limit(1)
            .maybeSingle();
          if (contact) {
            const { data: lastOut } = await admin
              .from('email_messages')
              .select('id, contact_id')
              .eq('contact_id', contact.id)
              .eq('direction', 'outbound')
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            messageId = lastOut?.id ?? null;
            contactId = lastOut?.contact_id ?? null;
          }
        }
      }
      // No CRM message to attribute (e.g. a system-notification email). Keep the
      // claimed receipt so it isn't reprocessed, and move on.
      if (!messageId) return NextResponse.json({ ok: true, ignored: 'no matching message' });

      const clickedUrl =
        isClick && typeof object?.link?.url === 'string' ? object.link.url : null;
      // Same atomic, bucket-bounded counter the /api/track pixel uses, so an
      // Emailit-tracked open/click increments open_count/click_count and lands
      // in email_events identically to a self-tracked one.
      const { data: counted } = await admin
        .rpc('track_email_event_bounded', {
          p_message_id: messageId,
          p_event: isClick ? 'click' : 'open',
          p_url: clickedUrl,
          p_bucket_seconds: 60,
        })
        .maybeSingle<{ message_id: string; contact_id: string | null; counted: boolean }>();

      const stopContact = counted?.contact_id ?? contactId;
      if (counted?.counted && stopContact) {
        await stopEnrollmentsFor(stopContact, isClick ? 'click' : 'open');
      }
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
    body?.data?.object?.to ??
    null;
  const recipientValue = Array.isArray(recipientCandidate)
    ? recipientCandidate[0]
    : recipientCandidate;
  const recipient =
    typeof recipientValue === 'object' ? recipientValue?.email ?? null : recipientValue;
  if (!recipient) return NextResponse.json({ ok: true, ignored: 'no recipient' });

  const eventId = body?.event_id ?? body?.id ?? null;
  const claimed = await claimWebhookReceipt('emailit', eventId);
  if (!claimed) return NextResponse.json({ ok: true, duplicate: true });

  try {
    const admin = createAdminClient();
    const { data: contact } = await admin
      .from('contacts')
      .select('id, name, status_id')
      .ilike('email', String(recipient))
      .limit(1)
      .maybeSingle();
    if (!contact) return NextResponse.json({ ok: true, ignored: 'no matching contact' });

    const { data: lastOut } = await admin
      .from('email_messages')
      .select('id')
      .eq('contact_id', contact.id)
      .eq('direction', 'outbound')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastOut) {
      await admin.from('email_messages').update({ bounced: true }).eq('id', lastOut.id);
      await admin.from('email_events').insert({
        message_id: lastOut.id,
        contact_id: contact.id,
        type: 'bounce',
        meta: { event: eventType, event_id: eventId },
      });
    }

    await stopEnrollmentsFor(contact.id, 'bounce');

    // Auto-status: prefer "Bounced", fall back to "Bad Email".
    const { data: bounceStatus } = await admin
      .from('statuses')
      .select('id, name')
      .in('name', ['Bounced', 'Bad Email'])
      .order('name') // "Bad Email" sorts first; prefer Bounced below
      .limit(2);
    const target =
      bounceStatus?.find((s) => s.name === 'Bounced') ?? bounceStatus?.[0] ?? null;
    if (target && contact.status_id !== target.id) {
      await admin.from('contacts').update({ status_id: target.id }).eq('id', contact.id);
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
