import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

/**
 * Verifies the request has a valid logged-in session and that the profile
 * is not disabled. Returns the user + a Supabase client scoped to their
 * session (so RLS still applies for anything done with it).
 */
export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, status')
    .eq('id', user.id)
    .single();

  if (!profile || profile.status !== 'active') {
    return { error: NextResponse.json({ error: 'Account disabled' }, { status: 403 }) };
  }

  return { user, profile, supabase };
}

/**
 * Same as requireUser, but additionally requires role === 'admin'.
 * Always re-checks against the DB — never trusts a client-supplied role.
 */
export async function requireAdmin() {
  const result = await requireUser();
  if ('error' in result) return result;

  if (result.profile.role !== 'admin') {
    return { error: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) };
  }

  return result;
}
