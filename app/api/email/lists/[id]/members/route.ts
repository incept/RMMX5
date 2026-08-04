import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { MAX_BULK_RECIPIENTS } from '@/lib/bulk-delivery';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';

type Params = { params: Promise<{ id: string }> };
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  if (!UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: 'A valid list id is required' }, { status: 400 });
  }

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
  const { data: list, error: listError } = await admin
    .from('email_lists')
    .select('id')
    .eq('id', id)
    .maybeSingle();
  if (listError) return apiFailure('api:email/lists/[id]/members', listError);
  if (!list) return NextResponse.json({ error: 'List not found' }, { status: 404 });

  // Insert only the contacts that aren't members yet, so the count is accurate
  // and a re-add can't error on the unique(list_id, contact_id) constraint.
  const ids = [...new Set(contactIds.map(String))];
  if (ids.some((contactId) => !UUID_PATTERN.test(contactId))) {
    return NextResponse.json({ error: 'contactIds must contain valid UUIDs' }, { status: 400 });
  }
  const { data: existing, error: existingError } = await admin
    .from('email_list_members')
    .select('contact_id')
    .eq('list_id', id)
    .in('contact_id', ids);
  if (existingError) return apiFailure('api:email/lists/[id]/members', existingError);

  const already = new Set((existing ?? []).map((m) => m.contact_id));
  const candidates = ids.filter((contactId) => !already.has(contactId));
  let added = 0;
  if (candidates.length) {
    // Conflict-safe under concurrent add requests. Returning inserted rows keeps
    // the reported count accurate without a read-then-insert race.
    const inserted = await admin
      .from('email_list_members')
      .upsert(
        candidates.map((contact_id) => ({ list_id: id, contact_id })),
        { onConflict: 'list_id,contact_id', ignoreDuplicates: true }
      )
      .select('contact_id');
    if (inserted.error) return apiFailure('api:email/lists/[id]/members', inserted.error);
    added = inserted.data?.length ?? 0;
  }

  return NextResponse.json({ added, skipped: ids.length - added });
}
