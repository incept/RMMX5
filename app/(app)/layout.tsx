import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import Sidebar from '@/components/Sidebar';

/** Authenticated shell: verifies the session server-side and renders the sidebar. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/');

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, status')
    .eq('id', user.id)
    .single();

  if (!profile || profile.status !== 'active') redirect('/');

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        role={profile.role}
        userName={profile.full_name || profile.email}
      />
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
