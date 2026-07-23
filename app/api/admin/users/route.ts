import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';

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
  const body = await request.json();

  if (!body.email || !body.password) {
    return NextResponse.json({ error: 'email and password required' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,
    user_metadata: { full_name: body.fullName ?? '' },
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // The signup trigger created the profile as 'worker'; honor a requested role.
  if (body.role === 'admin') {
    await admin.from('profiles').update({ role: 'admin' }).eq('id', data.user.id);
  }

  return NextResponse.json({ ok: true, userId: data.user.id });
}
