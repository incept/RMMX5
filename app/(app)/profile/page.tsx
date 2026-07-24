'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

/**
 * My Profile — available to every signed-in user (admin or worker).
 *
 * Name/phone/signature go to the profiles row (RLS allows updating your own,
 * and a DB trigger silently reverts any attempt to change role/status here).
 * Password and email changes go through Supabase Auth, not the profiles table.
 */
export default function ProfilePage() {
  const supabase = useMemo(() => createClient(), []);
  const [profile, setProfile] = useState<any>(null);
  const [authEmail, setAuthEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setAuthEmail(user.email ?? '');
    const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single();
    setProfile(data);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  function notify(kind: 'ok' | 'err', text: string) {
    setMessage({ kind, text });
    setTimeout(() => setMessage(null), 4000);
  }

  async function saveProfile() {
    setBusy('profile');
    const { error } = await supabase
      .from('profiles')
      .update({
        full_name: profile.full_name,
        phone: profile.phone,
        signature_html: profile.signature_html,
      })
      .eq('id', profile.id);
    setBusy(null);
    if (error) notify('err', error.message);
    else {
      notify('ok', 'Profile saved.');
      load();
    }
  }

  async function changePassword() {
    if (password.length < 8) return notify('err', 'Use at least 8 characters.');
    if (password !== confirm) return notify('err', 'Passwords do not match.');
    setBusy('password');
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(null);
    if (error) notify('err', error.message);
    else {
      setPassword('');
      setConfirm('');
      notify('ok', 'Password updated. It applies the next time you sign in.');
    }
  }

  async function changeEmail(next: string) {
    if (!next || next === authEmail) return;
    setBusy('email');
    const { error } = await supabase.auth.updateUser({ email: next });
    setBusy(null);
    if (error) notify('err', error.message);
    else notify('ok', `Confirmation sent to ${next}. The change applies once confirmed.`);
  }

  if (!profile) {
    return <div className="p-6 text-sm text-gray-400">Loading…</div>;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">My Profile</h1>
        <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600 uppercase">
          {profile.role}
        </span>
      </div>

      {message && (
        <div
          className={`rounded-lg px-3 py-2 text-sm ${
            message.kind === 'ok' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Personal details */}
      <div className="card">
        <h2 className="mb-3 text-sm font-semibold">Details</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Full name</label>
            <input
              className="input"
              value={profile.full_name ?? ''}
              onChange={(e) => setProfile({ ...profile, full_name: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Phone</label>
            <input
              className="input"
              value={profile.phone ?? ''}
              onChange={(e) => setProfile({ ...profile, phone: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <label className="label">Email signature (HTML)</label>
            <textarea
              className="input min-h-24 font-mono text-xs"
              placeholder="<p>Jane Doe — Case Manager</p>"
              value={profile.signature_html ?? ''}
              onChange={(e) => setProfile({ ...profile, signature_html: e.target.value })}
            />
            <p className="mt-1 text-xs text-gray-400">
              Note: sequence and campaign sends use the sending account’s signature; this one is
              for your personal use.
            </p>
          </div>
        </div>
        <button className="btn btn-primary mt-3" disabled={busy === 'profile'} onClick={saveProfile}>
          {busy === 'profile' ? 'Saving…' : 'Save details'}
        </button>
      </div>

      {/* Password */}
      <div className="card">
        <h2 className="mb-3 text-sm font-semibold">Change password</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">New password</label>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Confirm password</label>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && changePassword()}
            />
          </div>
        </div>
        <button
          className="btn btn-primary mt-3"
          disabled={busy === 'password'}
          onClick={changePassword}
        >
          {busy === 'password' ? 'Updating…' : 'Update password'}
        </button>
      </div>

      {/* Sign-in email */}
      <div className="card">
        <h2 className="mb-3 text-sm font-semibold">Sign-in email</h2>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className="label">Email</label>
            <input
              className="input"
              type="email"
              defaultValue={authEmail}
              onBlur={(e) => changeEmail(e.target.value.trim())}
            />
          </div>
        </div>
        <p className="mt-2 text-xs text-gray-400">
          Changing this sends a confirmation link to the new address; the change only takes effect
          after you confirm it.
        </p>
      </div>
    </div>
  );
}
