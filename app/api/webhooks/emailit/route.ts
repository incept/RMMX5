import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getSetting } from '@/lib/settings';
import { stopEnrollmentsFor } from '@/lib/sequence-runner';
import { logActivity } from '@/lib/activity';
import { verifyEmailitWebhook } from '@/lib/webhook-auth';
import { claimWebhookReceipt, releaseWebhookReceipt } from '@/lib/webhook-receipts';
import { readTextBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import { fetchEmailitMessage } from '@/lib/integrations/emailit';
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
      const full = await fetchEmailitMessage(String(emailId));
      if (!full.ok) throw new Error(full.error);
      const { contactId } = await recordInboundEmail({
        from: full.message.from || String(object.from ?? ''),
        to: full.message.to || String(object.to ?? ''),
        subject: full.message.subject || String(object.subject ?? ''),
        html: full.message.html,
        text: full.message.text,
        messageId: full.message.messageId ?? String(emailId),
      });
      return NextResponse.json({ ok: true, contact_id: contactId });
    } catch (error: any) {
      await releaseWebhookReceipt('emailit', receivedEventId);
      return NextResponse.json({ error: error?.message ?? 'Inbound email failed' }, { status: 500 });
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
