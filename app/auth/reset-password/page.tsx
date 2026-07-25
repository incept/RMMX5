'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState('Verifying reset link…');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    const code = new URLSearchParams(window.location.search).get('code');
    const verify = async () => {
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          setMessage('This reset link is invalid or expired.');
          return;
        }
      }
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        setMessage('This reset link is invalid or expired.');
        return;
      }
      setReady(true);
      setMessage('');
    };
    void verify();
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (password.length < 8) return setMessage('Use at least 8 characters.');
    if (password !== confirm) return setMessage('Passwords do not match.');
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) return setMessage(error.message);
    await supabase.auth.signOut();
    router.replace('/');
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form className="w-full max-w-sm" onSubmit={save}>
        <h1 className="text-xl font-semibold">Reset password</h1>
        <p className="mt-1 mb-6 text-sm text-gray-500">Choose a new workspace password.</p>
        {ready && (
          <>
            <label className="label">New password</label>
            <input
              className="input mb-3"
              type="password"
              minLength={8}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <label className="label">Confirm password</label>
            <input
              className="input mb-4"
              type="password"
              minLength={8}
              required
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
            <button className="btn btn-primary w-full justify-center" disabled={busy}>
              {busy ? 'Updating…' : 'Update password'}
            </button>
          </>
        )}
        {message && <div className="mt-3 text-sm text-amber-700">{message}</div>}
      </form>
    </main>
  );
}
