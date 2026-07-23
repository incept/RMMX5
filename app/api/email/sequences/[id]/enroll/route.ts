import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { enrollContact } from '@/lib/sequence-runner';

type Params = { params: Promise<{ id: string }> };

/**
 * POST enrolls contacts into a sequence.
 * Body: { contactIds?: string[], wholeList?: boolean }
 * wholeList enrolls every member of the sequence's list.
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const admin = createAdminClient();
  const { data: sequence } = await admin
    .from('email_sequences')
    .select('id, list_id')
    .eq('id', id)
    .single();
  if (!sequence) return NextResponse.json({ error: 'Sequence not found' }, { status: 404 });

  let contactIds: string[] = body.contactIds ?? [];
  if (body.wholeList && sequence.list_id) {
    const { data: members } = await admin
      .from('email_list_members')
      .select('contact_id')
      .eq('list_id', sequence.list_id);
    contactIds = [...new Set([...contactIds, ...(members ?? []).map((m) => m.contact_id)])];
  }

  if (!contactIds.length) {
    return NextResponse.json({ error: 'No contacts to enroll' }, { status: 400 });
  }

  for (const contactId of contactIds) {
    await enrollContact(id, contactId);
  }

  return NextResponse.json({ enrolled: contactIds.length });
}
