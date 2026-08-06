import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { renderTemplate } from '@/lib/render-template';
import { withLinkPlaceholders } from '@/lib/link-placeholders';
import { sendSms } from '@/lib/integrations/textlink';
import { logActivity } from '@/lib/activity';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import { errorMessage, logDebug } from '@/lib/debug-log';

type Params = { params: Promise<{ id: string }> };

// One TextLink call with a 20s internal timeout — safely inside this window.
export const maxDuration = 30;

/**
 * One-off SMS to a single contact, from the contact panel's SMS tab.
 * {{placeholders}} in the body are rendered against the contact (plain text).
 *
 * Admin-only: every send is a billed message on a physical TextLink device —
 * the same gate as one-off email. Sent SYNCHRONOUSLY (unlike bulk campaigns,
 * which queue) so the operator gets an immediate sent/failed result. Recorded in
 * sms_messages with a null campaign_id, and mirrored into activity_log, so the
 * SMS tab and the contact timeline both show it.
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const { id } = await params;

  let body: any;
  try {
    body = await readJsonBody(request, 64 * 1024);
  } catch (error) {
    return apiFailure('api:contacts/sms', error);
  }
  const rawBody = String(body.body ?? '').slice(0, 2000);
  if (!rawBody.trim()) {
    return NextResponse.json({ error: 'Message body is required' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: contact, error: contactError } = await admin
    .from('contacts')
    .select('id, name, phone, city, state, email, custom')
    .eq('id', id)
    .maybeSingle();
  if (contactError) return NextResponse.json({ error: contactError.message }, { status: 500 });
  if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
  if (!contact.phone) {
    return NextResponse.json(
      { error: 'This contact has no phone number on file' },
      { status: 422 }
    );
  }

  // Resolve {{link1}}..{{links}} from the contact's deep-search links first, then
  // the {{name}}/{{city}}/... fields. withLinkPlaceholders only reads the DB when
  // the body actually references a link, so a plain text costs nothing extra.
  const enriched = await withLinkPlaceholders(admin, contact, rawBody);
  const text = renderTemplate(rawBody, enriched);

  // A stable delivery key dedupes a double-submit (double-click, retried request):
  // the unique index on sms_messages.delivery_key rejects the second insert, so a
  // text can never go out twice. The client sends one Idempotency-Key per compose;
  // without it, each request is treated as a distinct send.
  const requestKey = request.headers.get('idempotency-key');
  const key = requestKey ? `oneoff-sms:${requestKey}` : null;

  const { data: message, error: insertError } = await admin
    .from('sms_messages')
    .insert({
      campaign_id: null,
      contact_id: contact.id,
      phone: contact.phone,
      body: text,
      status: 'queued',
      delivery_key: key,
    })
    .select('id')
    .single();
  if (insertError?.code === '23505' && key) {
    // Same idempotency key already sent (or is sending) — return that row rather
    // than firing a duplicate text.
    const { data: existing } = await admin
      .from('sms_messages')
      .select('id, status, body, phone, error, created_at')
      .eq('delivery_key', key)
      .maybeSingle();
    return NextResponse.json({
      ok: existing?.status === 'sent',
      duplicate: true,
      message: existing ?? null,
    });
  }
  if (insertError || !message) {
    return NextResponse.json(
      { error: insertError?.message ?? 'Could not record the message' },
      { status: 500 }
    );
  }

  const result = await sendSms(contact.phone, text);

  const { data: updated } = await admin
    .from('sms_messages')
    .update({ status: result.ok ? 'sent' : 'failed', error: result.error ?? null })
    .eq('id', message.id)
    .select('id, status, body, phone, direction, error, created_at')
    .maybeSingle();

  await logActivity({
    contactId: contact.id,
    actorId: auth.profile.id,
    type: 'sms',
    description: result.ok
      ? `SMS sent: "${text.slice(0, 120)}"`
      : `SMS failed: ${result.error ?? 'unknown error'} — "${text.slice(0, 120)}"`,
    meta: { sms_message_id: message.id },
  });

  if (!result.ok) {
    await logDebug({
      source: 'api:contacts/sms',
      message: `One-off SMS failed: ${errorMessage(result.error)}`,
      context: { to: contact.phone },
      contactId: contact.id,
    }).catch(() => {});
    return NextResponse.json(
      { ok: false, error: result.error ?? 'SMS delivery failed', message: updated ?? null },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, message: updated ?? null });
}
