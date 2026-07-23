'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

/** Landing page: login / register. The first account to register is auto-admin. */
export default function LandingPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const supabase = createClient();

    try {
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push('/dashboard');
        router.refresh();
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { full_name: fullName },
            emailRedirectTo: `${window.location.origin}/auth/callback`,
          },
        });
        if (error) throw error;
        setMessage(
          'Account created. If email confirmation is enabled, check your inbox — otherwise just log in.'
        );
        setMode('login');
      }
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
          <p className="mt-4 max-w-md text-gray-400">
            Reputation scoring, link tracking &amp; removal pipeline, email and SMS marketing,
            voicemail drops, and revenue projection — one spreadsheet-fast workspace.
          </p>
        </div>
        <div className="text-xs text-gray-500">
          Supabase-backed · BrightData · Emailit · TextLink · Stripe · Fluent Forms
        </div>
      </div>

      {/* Auth side */}
      <div className="flex flex-1 items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm">
          <div className="mb-6 lg:hidden">
            <span className="text-sm font-bold tracking-widest text-brand-600">RMMX5</span>
          </div>
          <h2 className="text-xl font-semibold">
            {mode === 'login' ? 'Sign in' : 'Create your account'}
          </h2>
          <p className="mt-1 mb-6 text-sm text-gray-500">
            {mode === 'login'
              ? 'Welcome back — sign in to your workspace.'
              : 'The first account registered becomes the admin.'}
          </p>

          {mode === 'register' && (
            <div className="mb-3">
              <label className="label">Full name</label>
              <input
                className="input"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Jane Doe"
              />
            </div>
          )}
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
            {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>

          {message && (
            <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {message}
            </div>
          )}

          <button
            type="button"
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
            className="mt-4 text-sm text-brand-600 hover:underline"
          >
            {mode === 'login' ? 'Need an account? Register' : 'Have an account? Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
