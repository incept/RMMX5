import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';

type Params = { params: Promise<{ id: string }> };

/** PATCH { role?, status?, fullName?, phone? } — admin edits a user. */
export async function PATCH(request: Request, { params }: Params) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const { id } = await params;
  let body: any;
  try {
    body = await readJsonBody(request, 64 * 1024);
  } catch (error) {
    return apiFailure('api:admin/users/[id]', error);
  }

  if (id === auth.profile.id && (body.role === 'worker' || body.status === 'disabled')) {
    return NextResponse.json(
      { error: 'You cannot demote or disable your own account' },
      { status: 400 }
    );
  }

  // Whitelist: is_admin() checks role = 'admin' exactly, so an arbitrary
  // string here would silently create a roleless account.
  if (body.role && !['admin', 'worker'].includes(body.role)) {
    return NextResponse.json({ error: `Invalid role: ${body.role}` }, { status: 400 });
  }
  if (body.status && !['active', 'disabled'].includes(body.status)) {
    return NextResponse.json({ error: `Invalid status: ${body.status}` }, { status: 400 });
  }

  const updates: Record<string, any> = {};
  if (body.role) updates.role = body.role;
  if (body.status) updates.status = body.status;
  if ('fullName' in body) updates.full_name = String(body.fullName ?? '').trim().slice(0, 200);
  if ('phone' in body) updates.phone = String(body.phone ?? '').trim().slice(0, 50);
  if (!Object.keys(updates).length) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  const { error } = await createAdminClient().from('profiles').update(updates).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

/** DELETE — removes the auth user (cascades to the profile). */
export async function DELETE(_request: Request, { params }: Params) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const { id } = await params;

  if (id === auth.profile.id) {
    return NextResponse.json({ error: 'You cannot delete your own account' }, { status: 400 });
  }

  const { error } = await createAdminClient().auth.admin.deleteUser(id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
