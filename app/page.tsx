'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

/** Landing page: sign-in only. Accounts are provisioned by an administrator. */
export default function LandingPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const supabase = createClient();

    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const { data: profile, error: profileError } = user
        ? await supabase.from('profiles').select('status').eq('id', user.id).maybeSingle()
        : { data: null, error: null };
      if (profileError) throw profileError;
      if (profile?.status !== 'active') {
        await supabase.auth.signOut();
        throw new Error('This account is awaiting activation by an administrator.');
      }
      router.push('/dashboard');
      router.refresh();
    } catch (err: any) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen">
      {/* Brand side */}
      <div className="hidden flex-1 flex-col justify-between bg-gray-950 p-10 text-white lg:flex">
        <div className="text-sm font-bold tracking-widest text-brand-500">RMMX5</div>
        <div>
          <h1 className="max-w-md text-4xl leading-tight font-semibold">
            Crisis Management CRM
          </h1>
        </div>
        <div />

      </div>

      {/* Auth side */}
      <div className="flex flex-1 items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm">
          <div className="mb-6 lg:hidden">
            <span className="text-sm font-bold tracking-widest text-brand-600">RMMX5</span>
          </div>
          <h2 className="text-xl font-semibold">Sign in</h2>
          <p className="mt-1 mb-6 text-sm text-gray-500">
            Welcome back — sign in to your workspace.
          </p>

          <div className="mb-3">
            <label className="label">Email</label>
            <input
              className="input"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </div>
          <div className="mb-4">
            <label className="label">Password</label>
            <input
              className="input"
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          <button className="btn btn-primary w-full justify-center" disabled={busy}>
            {busy ? 'Working…' : 'Sign in'}
          </button>

          {message && (
            <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {message}
            </div>
          )}

          <p className="mt-4 text-center text-xs text-gray-400">
            Need access? Ask a workspace administrator to create your account.
          </p>
        </form>
      </div>
    </main>
  );
}
