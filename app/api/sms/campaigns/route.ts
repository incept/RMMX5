import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { sendSms } from '@/lib/integrations/textlink';
import { renderTemplate } from '@/lib/sequence-runner';
import { logActivity } from '@/lib/activity';

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

  const admin = createAdminClient();
  const { data: campaign, error } = await admin
    .from('sms_campaigns')
    .insert({
      name: body.name,
      body: body.body,
      list_id: body.listId,
      status: body.sendNow ? 'sending' : 'draft',
      created_by: auth.profile.id,
    })
    .select('*')
    .single();
  if (error || !campaign) {
    return NextResponse.json({ error: error?.message ?? 'insert failed' }, { status: 400 });
  }

  if (!body.sendNow) return NextResponse.json({ campaign });

  const { data: members } = await admin
    .from('email_list_members')
    .select('contacts ( id, name, phone, city, state, custom )')
    .eq('list_id', body.listId);

  let sent = 0;
  let failed = 0;
  for (const member of (members ?? []) as any[]) {
    const contact = member.contacts;
    if (!contact?.phone) continue;
    const text = renderTemplate(campaign.body, contact);

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

    await admin.from('sms_messages').insert({
      campaign_id: campaign.id,
      contact_id: contact.id,
      phone: contact.phone,
      body: text,
      status,
      error: errorNote,
    });
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
