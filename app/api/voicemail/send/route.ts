import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { sendVoicemailDrop } from '@/lib/integrations/voicemail';
import { logActivity } from '@/lib/activity';

const BUCKET = 'voicemail-audio';

/**
 * POST { dropId, contactIds?: string[], listId? } — sends a voicemail drop
 * to the given contacts (or every list member with a phone number).
 */
export async function POST(request: Request) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const body = await request.json();
  if (!body.dropId) return NextResponse.json({ error: 'dropId required' }, { status: 400 });

  const admin = createAdminClient();
  const { data: drop } = await admin
    .from('voicemail_drops')
    .select('*')
    .eq('id', body.dropId)
    .single();
  if (!drop) return NextResponse.json({ error: 'Drop not found' }, { status: 404 });

  // Signed URL the provider can fetch for the next 24h.
  const { data: signed } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(drop.audio_path, 86400);
  if (!signed?.signedUrl) {
    return NextResponse.json({ error: 'Could not sign audio URL' }, { status: 500 });
  }

  let contacts: { id: string; name: string; phone: string | null }[] = [];
  if (body.listId) {
    const { data: members } = await admin
      .from('email_list_members')
      .select('contacts ( id, name, phone )')
      .eq('list_id', body.listId);
    contacts = ((members ?? []) as any[]).map((m) => m.contacts).filter(Boolean);
  }
  if (body.contactIds?.length) {
    const { data } = await admin
      .from('contacts')
      .select('id, name, phone')
      .in('id', body.contactIds);
    contacts = [...contacts, ...(data ?? [])];
  }
  contacts = contacts.filter((c) => c.phone);
  if (!contacts.length) {
    return NextResponse.json({ error: 'No contacts with phone numbers' }, { status: 400 });
  }

  let sent = 0;
  let failed = 0;
  for (const contact of contacts) {
    let status: 'sent' | 'failed' = 'sent';
    let errorNote: string | null = null;
    try {
      const r = await sendVoicemailDrop({ phone: contact.phone!, audioUrl: signed.signedUrl });
      if (!r.ok) {
        status = 'failed';
        errorNote = r.error ?? 'unknown';
      }
    } catch (e: any) {
      status = 'failed';
      errorNote = e.message;
    }

    await admin.from('voicemail_sends').insert({
      drop_id: drop.id,
      contact_id: contact.id,
      phone: contact.phone,
      status,
      error: errorNote,
    });
    await logActivity({
      contactId: contact.id,
      actorId: auth.profile.id,
      type: 'voicemail',
      description:
        status === 'sent'
          ? `Voicemail drop sent ("${drop.name}")`
          : `Voicemail drop failed: ${errorNote}`,
    });

    if (status === 'sent') sent += 1;
    else failed += 1;
  }

  return NextResponse.json({ sent, failed });
}
