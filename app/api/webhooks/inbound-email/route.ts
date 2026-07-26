import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getSetting } from '@/lib/settings';
import { stopEnrollmentsFor } from '@/lib/sequence-runner';
import { logActivity } from '@/lib/activity';
import { verifyBearerSecret } from '@/lib/webhook-auth';
import { claimWebhookReceipt, releaseWebhookReceipt } from '@/lib/webhook-receipts';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
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
    const admin = createAdminClient();
    const extracted = String(body.from).match(/[^\s<>"]+@[^\s<>"]+/)?.[0] ?? String(body.from);
    const fromEmail = extracted.trim().toLowerCase().slice(0, 320);
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail);

    const { data: contact } = validEmail
      ? await admin
          .from('contacts')
          .select('id, name')
          .eq('email_normalized', fromEmail)
          .limit(1)
          .maybeSingle()
      : { data: null };

    const { data: message, error: messageError } = await admin
      .from('email_messages')
      .insert({
        contact_id: contact?.id ?? null,
        direction: 'inbound',
        from_email: fromEmail,
        to_email: String(body.to ?? '').slice(0, 320),
        subject: String(body.subject ?? '(no subject)').slice(0, 500),
        html: String(body.html ?? body.text ?? '').slice(0, 750_000),
        message_id: body.message_id ? String(body.message_id).slice(0, 1000) : null,
        in_reply_to: body.in_reply_to ? String(body.in_reply_to).slice(0, 1000) : null,
        status: 'received',
        sent_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (messageError) throw messageError;

    if (contact) {
      // Mark the latest outbound message to this contact as replied.
      const { data: lastOut } = await admin
        .from('email_messages')
        .select('id')
        .eq('contact_id', contact.id)
        .eq('direction', 'outbound')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastOut) {
        await admin.from('email_messages').update({ replied: true }).eq('id', lastOut.id);
        await admin.from('email_events').insert({
          message_id: lastOut.id,
          contact_id: contact.id,
          type: 'reply',
        });
      }
      await stopEnrollmentsFor(contact.id, 'reply');
      await logActivity({
        contactId: contact.id,
        type: 'email',
        description: `Reply received from ${fromEmail}: "${body.subject ?? ''}"`,
        meta: { message_row_id: message?.id },
      });
    }

    return NextResponse.json({ ok: true, contact_id: contact?.id ?? null });
  } catch (error: any) {
    await releaseWebhookReceipt('inbound_email', eventId);
    return NextResponse.json({ error: error?.message ?? 'Inbound email failed' }, { status: 500 });
  }
}
