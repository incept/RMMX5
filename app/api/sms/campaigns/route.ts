import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { renderTemplate } from '@/lib/sequence-runner';
import { deliveryKey, MAX_BULK_RECIPIENTS, validIdempotencyKey } from '@/lib/bulk-delivery';
import { enqueueJob } from '@/lib/job-queue';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  let body: any;
  try {
    body = await readJsonBody(request, 256 * 1024);
  } catch (error) {
    return apiFailure('api:sms/campaigns', error);
  }
  body.name = String(body.name ?? '').trim().slice(0, 200);
  body.body = String(body.body ?? '').slice(0, 20_000);
  if (!body.name || !body.body || !body.listId) {
    return NextResponse.json({ error: 'name, body and listId required' }, { status: 400 });
  }

  const requestKey = request.headers.get('idempotency-key');
  if (body.sendNow && !['admin', 'super_admin'].includes(auth.profile.role)) {
    return NextResponse.json({ error: 'Admin access required to send campaigns' }, { status: 403 });
  }
  if (body.sendNow && !validIdempotencyKey(requestKey)) {
    return NextResponse.json({ error: 'A valid Idempotency-Key header is required' }, { status: 400 });
  }

  const admin = createAdminClient();
  if (body.sendNow) {
    const { data: existing } = await admin
      .from('sms_campaigns')
      .select('*')
      .eq('request_key', requestKey)
      .maybeSingle();
    if (existing) return NextResponse.json({ campaign: existing, duplicate: true });
  }

  let members: any[] = [];
  if (body.sendNow) {
    const result = await admin
      .from('email_list_members')
      .select('contacts ( id, name, phone, city, state, custom )', { count: 'exact' })
      .eq('list_id', body.listId)
      .range(0, MAX_BULK_RECIPIENTS);
    if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });
    if ((result.count ?? 0) > MAX_BULK_RECIPIENTS) {
      return NextResponse.json(
        { error: `SMS sends are limited to ${MAX_BULK_RECIPIENTS} recipients per request` },
        { status: 413 }
      );
    }
    members = result.data ?? [];
  }

  const { data: campaign, error } = await admin
    .from('sms_campaigns')
    .insert({
      name: body.name,
      body: body.body,
      list_id: body.listId,
      status: body.sendNow ? 'sending' : 'draft',
      created_by: auth.profile.id,
      request_key: body.sendNow ? requestKey : null,
    })
    .select('*')
    .single();
  if (error?.code === '23505' && body.sendNow) {
    const { data: existing } = await admin
      .from('sms_campaigns')
      .select('*')
      .eq('request_key', requestKey)
      .maybeSingle();
    if (existing) return NextResponse.json({ campaign: existing, duplicate: true });
  }
  if (error || !campaign) {
    return NextResponse.json({ error: error?.message ?? 'insert failed' }, { status: 400 });
  }
  if (!body.sendNow) return NextResponse.json({ campaign });

  let queued = 0;
  for (const member of members) {
    const contact = member.contacts;
    if (!contact?.phone) continue;
    const text = renderTemplate(campaign.body, contact);
    const key = deliveryKey('sms', requestKey!, contact.id);
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
    if (reserveError?.code === '23505') continue;
    if (reserveError || !message) continue;
    try {
      await enqueueJob(
        'sms_delivery',
        {
          messageId: message.id,
          campaignId: campaign.id,
          campaignName: campaign.name,
          contactId: contact.id,
          actorId: auth.profile.id,
          phone: contact.phone,
          body: text,
        },
        `job:${key}`
      );
      queued += 1;
    } catch (queueError: any) {
      await admin
        .from('sms_messages')
        .update({ status: 'failed', error: queueError.message })
        .eq('id', message.id);
    }
  }
  return NextResponse.json({ campaign: { ...campaign, queued_count: queued } }, { status: 202 });
}
