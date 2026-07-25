import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { enrollContact } from '@/lib/sequence-runner';
import { MAX_BULK_RECIPIENTS } from '@/lib/bulk-delivery';
import { readJsonBody, requestErrorResponse } from '@/lib/request-limits';

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
  let body: any;
  try {
    body = await readJsonBody(request, 256 * 1024);
  } catch (error) {
    const response = requestErrorResponse(error);
    return NextResponse.json({ error: response.message }, { status: response.status });
  }
  if (body.contactIds != null && !Array.isArray(body.contactIds)) {
    return NextResponse.json({ error: 'contactIds must be an array' }, { status: 400 });
  }
  if ((body.contactIds?.length ?? 0) > MAX_BULK_RECIPIENTS) {
    return NextResponse.json({ error: `Maximum ${MAX_BULK_RECIPIENTS} contacts` }, { status: 413 });
  }

  const admin = createAdminClient();
  const { data: sequence } = await admin
    .from('email_sequences')
    .select('id, list_id')
    .eq('id', id)
    .single();
  if (!sequence) return NextResponse.json({ error: 'Sequence not found' }, { status: 404 });

  let contactIds: string[] = body.contactIds ?? [];
  if (body.wholeList && sequence.list_id) {
    const { data: members, count, error } = await admin
      .from('email_list_members')
      .select('contact_id', { count: 'exact' })
      .eq('list_id', sequence.list_id)
      .range(0, MAX_BULK_RECIPIENTS);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if ((count ?? 0) > MAX_BULK_RECIPIENTS) {
      return NextResponse.json(
        { error: `Sequence enrollments are limited to ${MAX_BULK_RECIPIENTS} contacts` },
        { status: 413 }
      );
    }
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
