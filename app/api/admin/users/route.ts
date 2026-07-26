import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import { logDebug } from '@/lib/debug-log';

/** GET — list all profiles (admin). */
export async function GET() {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;

  const { data: users, error } = await createAdminClient()
    .from('profiles')
    .select('*')
    .order('created_at');
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ users });
}

/** POST { email, password, fullName, role } — create a user without email confirmation. */
export async function POST(request: Request) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  let body: any;
  try {
    body = await readJsonBody(request, 64 * 1024);
  } catch (error) {
    return apiFailure('api:admin/users', error);
  }
  body.email = String(body.email ?? '').trim().toLowerCase().slice(0, 320);
  body.fullName = String(body.fullName ?? '').trim().slice(0, 200);

  if (!body.email || !body.password) {
    return NextResponse.json({ error: 'email and password required' }, { status: 400 });
  }
  if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 128) {
    return NextResponse.json(
      { error: 'password must be between 8 and 128 characters' },
      { status: 400 }
    );
  }
  if (body.role != null && !['admin', 'worker', 'super_admin'].includes(body.role)) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
  }
  if (body.role === 'super_admin' && auth.profile.role !== 'super_admin') {
    return NextResponse.json({ error: 'Only a super administrator can assign that role' }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,
    user_metadata: { full_name: body.fullName ?? '' },
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // The Auth trigger intentionally creates disabled workers. An authenticated
  // administrator is the only path that activates a new app account.
  const { error: profileError } = await admin
    .from('profiles')
    .update({
      role: ['admin', 'super_admin'].includes(body.role) ? body.role : 'worker',
      status: 'active',
    })
    .eq('id', data.user.id);
  if (profileError) {
    // Avoid leaving an unusable Auth user behind when profile activation fails.
    await admin.auth.admin.deleteUser(data.user.id);
    return NextResponse.json({ error: profileError.message }, { status: 400 });
  }

  await logDebug({
    level: 'info',
    source: 'admin:users',
    message: `${auth.profile.email} created ${body.email} as ${body.role ?? 'worker'}`,
    context: { actor_id: auth.profile.id, target_id: data.user.id, role: body.role ?? 'worker' },
  });
  return NextResponse.json({ ok: true, userId: data.user.id });
}
