import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { MAX_BULK_RECIPIENTS } from '@/lib/bulk-delivery';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';

type Params = { params: Promise<{ id: string }> };

/**
 * POST adds contacts to an email list in bulk. Body: { contactIds: string[] }.
 * Membership is unique per (list_id, contact_id), so re-adding an existing
 * member is a clean no-op — the response reports how many were newly added vs.
 * already present. Admin-only, like the sequence-enroll sibling.
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const { id } = await params;

  let body: any;
  try {
    body = await readJsonBody(request, 256 * 1024);
  } catch (error) {
    return apiFailure('api:email/lists/[id]/members', error);
  }
  const contactIds: unknown = body.contactIds;
  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return NextResponse.json({ error: 'contactIds must be a non-empty array' }, { status: 400 });
  }
  if (contactIds.length > MAX_BULK_RECIPIENTS) {
    return NextResponse.json({ error: `Maximum ${MAX_BULK_RECIPIENTS} contacts` }, { status: 413 });
  }

  const admin = createAdminClient();
  const { data: list } = await admin.from('email_lists').select('id').eq('id', id).single();
  if (!list) return NextResponse.json({ error: 'List not found' }, { status: 404 });

  // Insert only the contacts that aren't members yet, so the count is accurate
  // and a re-add can't error on the unique(list_id, contact_id) constraint.
  const ids = [...new Set(contactIds.map(String))];
  const { data: existing, error: existingError } = await admin
    .from('email_list_members')
    .select('contact_id')
    .eq('list_id', id)
    .in('contact_id', ids);
  if (existingError) return apiFailure('api:email/lists/[id]/members', existingError);

  const already = new Set((existing ?? []).map((m) => m.contact_id));
  const toAdd = ids.filter((c) => !already.has(c));
  if (toAdd.length) {
    const { error } = await admin
      .from('email_list_members')
      .insert(toAdd.map((contact_id) => ({ list_id: id, contact_id })));
    if (error) return apiFailure('api:email/lists/[id]/members', error);
  }

  return NextResponse.json({ added: toAdd.length, skipped: ids.length - toAdd.length });
}
