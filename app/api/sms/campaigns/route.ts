import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { sendSms } from '@/lib/integrations/textlink';
import { renderTemplate } from '@/lib/sequence-runner';
import { logActivity } from '@/lib/activity';
import { deliveryKey, MAX_BULK_RECIPIENTS, validIdempotencyKey } from '@/lib/bulk-delivery';

/**
 * POST { name, body, listId, sendNow } — creates an SMS campaign and,
 * if sendNow, blasts it to every list member with a phone number via
 * TextLink. {{placeholders}} render per contact.
 */
export async function POST(request: Request) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const body = await request.json();

  if (!body.name || !body.body || !body.listId) {
    return NextResponse.json({ error: 'name, body and listId required' }, { status: 400 });
  }
  if (body.sendNow && !validIdempotencyKey(body.idempotencyKey)) {
    return NextResponse.json({ error: 'A valid idempotencyKey is required to send now' }, { status: 400 });
  }

  const admin = createAdminClient();
  if (body.sendNow) {
    const { data: existing } = await admin
      .from('sms_campaigns')
      .select('*')
      .eq('request_key', body.idempotencyKey)
      .maybeSingle();
    if (existing) return NextResponse.json({ campaign: existing, duplicate: true });
  }
  const { data: campaign, error } = await admin
    .from('sms_campaigns')
    .insert({
      name: body.name,
      body: body.body,
      list_id: body.listId,
      status: body.sendNow ? 'sending' : 'draft',
      created_by: auth.profile.id,
      request_key: body.sendNow ? body.idempotencyKey : null,
    })
    .select('*')
    .single();
  if (error?.code === '23505' && body.sendNow) {
    const { data: existing } = await admin
      .from('sms_campaigns')
      .select('*')
      .eq('request_key', body.idempotencyKey)
      .maybeSingle();
    if (existing) return NextResponse.json({ campaign: existing, duplicate: true });
  }
  if (error || !campaign) {
    return NextResponse.json({ error: error?.message ?? 'insert failed' }, { status: 400 });
  }

  if (!body.sendNow) return NextResponse.json({ campaign });

  const { data: members, count } = await admin
      .from('email_list_members')
      .select('contacts ( id, name, phone, city, state, custom )', { count: 'exact' })
      .eq('list_id', body.listId)
      .range(0, MAX_BULK_RECIPIENTS - 1);
  if ((count ?? 0) > MAX_BULK_RECIPIENTS) {
    await admin.from('sms_campaigns').update({ status: 'failed' }).eq('id', campaign.id);
    return NextResponse.json(
      { error: `SMS sends are limited to ${MAX_BULK_RECIPIENTS} recipients per request` },
      { status: 413 }
    );
  }

  let sent = 0;
  let failed = 0;
  for (const member of (members ?? []) as any[]) {
    const contact = member.contacts;
    if (!contact?.phone) continue;
    const text = renderTemplate(campaign.body, contact);
    const key = deliveryKey('sms', body.idempotencyKey, contact.id);
    const { data: message, error: reserveError } = await admin
      .from('sms_messages')
      .insert({
        campaign_id: campaign.id,
        contact_id: contact.id,
        phone: contact.phone,
        body: text,
        status: 'queued',
        delivery_key: key,
      })
      .select('id')
      .single();
    if (reserveError?.code === '23505') {
      const { data: existing } = await admin
        .from('sms_messages')
        .select('status')
        .eq('delivery_key', key)
        .maybeSingle();
      if (existing?.status === 'sent') sent += 1;
      else failed += 1;
      continue;
    }
    if (reserveError || !message) {
      failed += 1;
      continue;
    }

    let status: 'sent' | 'failed' = 'sent';
    let errorNote: string | null = null;
    try {
      const r = await sendSms(contact.phone, text);
      if (!r.ok) {
        status = 'failed';
        errorNote = r.error ?? 'unknown';
      }
    } catch (e: any) {
      status = 'failed';
      errorNote = e.message;
    }

    await admin.from('sms_messages').update({ status, error: errorNote }).eq('id', message.id);
    await logActivity({
      contactId: contact.id,
      actorId: auth.profile.id,
      type: 'sms',
      description:
        status === 'sent' ? `SMS sent (campaign "${campaign.name}")` : `SMS failed: ${errorNote}`,
    });

    if (status === 'sent') sent += 1;
    else failed += 1;
  }

  await admin
    .from('sms_campaigns')
    .update({ status: failed && !sent ? 'failed' : 'sent', sent_count: sent, failed_count: failed })
    .eq('id', campaign.id);

  return NextResponse.json({ campaign: { ...campaign, sent_count: sent, failed_count: failed } });
}
