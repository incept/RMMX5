import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { deliveryKey, MAX_BULK_RECIPIENTS, validIdempotencyKey } from '@/lib/bulk-delivery';
import { enqueueJob } from '@/lib/job-queue';

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const body = await request.json();
  if (!body.dropId) return NextResponse.json({ error: 'dropId required' }, { status: 400 });
  const requestKey = request.headers.get('idempotency-key');
  if (!validIdempotencyKey(requestKey)) {
    return NextResponse.json({ error: 'A valid Idempotency-Key header is required' }, { status: 400 });
  }
  if (Array.isArray(body.contactIds) && body.contactIds.length > MAX_BULK_RECIPIENTS) {
    return NextResponse.json({ error: `Maximum ${MAX_BULK_RECIPIENTS} contacts` }, { status: 413 });
  }

  const admin = createAdminClient();
  const { data: drop } = await admin
    .from('voicemail_drops')
    .select('id, name, audio_path')
    .eq('id', body.dropId)
    .single();
  if (!drop) return NextResponse.json({ error: 'Drop not found' }, { status: 404 });

  let contacts: { id: string; name: string; phone: string | null }[] = [];
  if (body.listId) {
    const result = await admin
      .from('email_list_members')
      .select('contacts ( id, name, phone )', { count: 'exact' })
      .eq('list_id', body.listId)
      .range(0, MAX_BULK_RECIPIENTS);
    if ((result.count ?? 0) > MAX_BULK_RECIPIENTS) {
      return NextResponse.json(
        { error: `Voicemail sends are limited to ${MAX_BULK_RECIPIENTS} recipients per request` },
        { status: 413 }
      );
    }
    contacts = ((result.data ?? []) as any[]).map((member) => member.contacts).filter(Boolean);
  }
  if (body.contactIds?.length) {
    const { data } = await admin
      .from('contacts')
      .select('id, name, phone')
      .in('id', body.contactIds);
    contacts.push(...(data ?? []));
  }
  contacts = [...new Map(contacts.filter((contact) => contact.phone).map((contact) => [contact.id, contact])).values()];
  if (contacts.length > MAX_BULK_RECIPIENTS) {
    return NextResponse.json(
      { error: `Voicemail sends are limited to ${MAX_BULK_RECIPIENTS} recipients per request` },
      { status: 413 }
    );
  }
  if (!contacts.length) {
    return NextResponse.json({ error: 'No contacts with phone numbers' }, { status: 400 });
  }

  let queued = 0;
  let duplicates = 0;
  for (const contact of contacts) {
    const key = deliveryKey('voicemail', requestKey, contact.id);
    const { data: sendRow, error } = await admin
      .from('voicemail_sends')
      .insert({
        drop_id: drop.id,
        contact_id: contact.id,
        phone: contact.phone!,
        status: 'queued',
        delivery_key: key,
      })
      .select('id')
      .single();
    if (error?.code === '23505') {
      duplicates += 1;
      continue;
    }
    if (error || !sendRow) continue;
    try {
      await enqueueJob(
        'voicemail_delivery',
        {
          sendId: sendRow.id,
          dropName: drop.name,
          audioPath: drop.audio_path,
          contactId: contact.id,
          actorId: auth.profile.id,
          phone: contact.phone!,
        },
        `job:${key}`
      );
      queued += 1;
    } catch (queueError: any) {
      await admin
        .from('voicemail_sends')
        .update({ status: 'failed', error: queueError.message })
        .eq('id', sendRow.id);
    }
  }
  return NextResponse.json({ queued, duplicates }, { status: 202 });
}
