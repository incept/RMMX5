import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getSetting } from '@/lib/settings';
import { stopEnrollmentsFor } from '@/lib/sequence-runner';
import { logActivity } from '@/lib/activity';
import { safeEqual } from '@/lib/signing';

/**
 * Emailit event webhook (bounces & complaints) — configure in the Emailit
 * dashboard to POST here:  /api/webhooks/emailit?secret=<webhook_secret>
 *
 * A hard bounce:
 *   * flags the contact's latest outbound message as bounced
 *   * stops sequences with a "bounce" stop trigger
 *   * flips the contact's status to "Bad Email" / "Bounced" if those exist
 *     (the email-removal alert: stop mailing dead addresses immediately)
 */
export async function POST(request: Request) {
  const cfg = await getSetting<{ webhook_secret?: string }>('fluent_forms');
  const secret = new URL(request.url).searchParams.get('secret');
  if (!cfg.webhook_secret || !secret || !safeEqual(secret, cfg.webhook_secret)) {
    return NextResponse.json({ error: 'Invalid secret' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const eventType = String(body?.type ?? body?.event ?? '').toLowerCase();
  const recipient =
    body?.email ?? body?.recipient ?? body?.data?.email ?? body?.data?.to ?? null;
  if (!recipient) return NextResponse.json({ ok: true, ignored: 'no recipient' });

  if (!eventType.includes('bounce') && !eventType.includes('complaint')) {
    return NextResponse.json({ ok: true, ignored: eventType });
  }

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
      meta: { event: eventType },
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
}
