import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getSetting } from '@/lib/settings';
import { stopEnrollmentsFor } from '@/lib/sequence-runner';
import { logActivity } from '@/lib/activity';
import { verifyEmailitWebhook } from '@/lib/webhook-auth';
import { claimWebhookReceipt, releaseWebhookReceipt } from '@/lib/webhook-receipts';

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
  const rawBody = await request.text();
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
