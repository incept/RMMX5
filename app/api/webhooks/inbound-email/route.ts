import { NextResponse } from 'next/server';
import { getSetting } from '@/lib/settings';
import { verifyBearerSecret } from '@/lib/webhook-auth';
import { claimWebhookReceipt, releaseWebhookReceipt } from '@/lib/webhook-receipts';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import { recordInboundEmail } from '@/lib/inbound-email';
import { createHash } from 'crypto';

/**
 * Generic inbound-email webhook → unified inbox.
 * Point Emailit inbound routing (or any mail forwarder that can POST JSON)
 * at: POST /api/webhooks/inbound-email with an Authorization: Bearer header.
 * Body: { from, to, subject, html?, text?, message_id?, in_reply_to? }
 *
 * Matches the sender to a contact by email, records the message as a reply,
 * and stops any sequences with a "reply" stop trigger.
 */
export async function POST(request: Request) {
  const cfg = await getSetting<{ webhook_secret?: string }>('inbound_email');
  if (!verifyBearerSecret(request, cfg.webhook_secret)) {
    return NextResponse.json({ error: 'Invalid webhook authorization' }, { status: 401 });
  }

  let body: any;
  try {
    body = await readJsonBody(request, 1024 * 1024);
  } catch (error) {
    return apiFailure('api:webhooks/inbound-email', error);
  }
  if (!body?.from) return NextResponse.json({ error: 'from required' }, { status: 400 });

  const eventId =
    body.message_id ??
    request.headers.get('x-rmmx-idempotency-key') ??
    `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
  const claimed = await claimWebhookReceipt('inbound_email', eventId);
  if (!claimed) return NextResponse.json({ ok: true, duplicate: true });

  try {
    const { contactId } = await recordInboundEmail({
      from: body.from,
      to: body.to,
      subject: body.subject,
      html: body.html,
      text: body.text,
      messageId: body.message_id,
      inReplyTo: body.in_reply_to,
    });
    return NextResponse.json({ ok: true, contact_id: contactId });
  } catch (error: any) {
    await releaseWebhookReceipt('inbound_email', eventId);
    return NextResponse.json({ error: error?.message ?? 'Inbound email failed' }, { status: 500 });
  }
}
