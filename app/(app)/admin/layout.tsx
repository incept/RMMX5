import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

/** Authoritative admin gate — the sidebar hiding admin links is cosmetic only. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, status')
    .eq('id', user.id)
    .single();

  if (!profile || !['admin', 'super_admin'].includes(profile.role) || profile.status !== 'active') {
    redirect('/dashboard');
  }

  return <>{children}</>;
}
