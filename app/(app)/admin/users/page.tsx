'use client';

import { useCallback, useEffect, useState } from 'react';

/** Admin: user management (admins & workers). */
export default function UsersPage() {
  const [users, setUsers] = useState<any[]>([]);
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/users');
    if (res.ok) setUsers((await res.json()).users ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createUser() {
    if (!form.email || !form.password) return alert('Email and password required');
    setBusy(true);
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    setBusy(false);
    if (res.ok) {
      setForm(null);
      load();
    } else alert((await res.json()).error ?? 'Create failed');
  }

  async function patchUser(id: string, patch: Record<string, any>) {
    const res = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) alert((await res.json()).error ?? 'Update failed');
    load();
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Users</h1>
        <button className="btn btn-primary" onClick={() => setForm({ role: 'worker' })}>
          + Add user
        </button>
      </div>

      <div className="card p-0">
        <table className="w-full">
          <thead>
            <tr>
              <th className="grid-th">Name</th>
              <th className="grid-th">Email</th>
              <th className="grid-th">Role</th>
              <th className="grid-th">Status</th>
              <th className="grid-th">Created</th>
              <th className="grid-th"></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="grid-td font-medium">{u.full_name || '—'}</td>
                <td className="grid-td text-gray-500">{u.email}</td>
                <td className="grid-td">
                  <select
                    className="input w-28 py-1"
                    value={u.role}
                    onChange={(e) => patchUser(u.id, { role: e.target.value })}
                  >
                    <option value="admin">Admin</option>
                    <option value="worker">Worker</option>
                  </select>
                </td>
                <td className="grid-td">
                  <button
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      u.status === 'active'
                        ? 'bg-green-100 text-green-700'
                        : 'bg-red-100 text-red-700'
                    }`}
                    onClick={() =>
                      patchUser(u.id, { status: u.status === 'active' ? 'disabled' : 'active' })
                    }
                  >
                    {u.status}
                  </button>
                </td>
                <td className="grid-td text-gray-400">
                  {new Date(u.created_at).toLocaleDateString()}
                </td>
                <td className="grid-td">
                  <button
                    className="text-xs text-gray-400 hover:text-red-600"
                    onClick={async () => {
                      if (!confirm(`Delete ${u.email}? This cannot be undone.`)) return;
                      const res = await fetch(`/api/admin/users/${u.id}`, { method: 'DELETE' });
                      if (!res.ok) alert((await res.json()).error ?? 'Delete failed');
                      load();
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {form && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20" onClick={() => setForm(null)}>
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-3 text-sm font-semibold">New user</h2>
            <div className="space-y-2">
              <input
                className="input"
                placeholder="Full name"
                value={form.fullName ?? ''}
                onChange={(e) => setForm((f: any) => ({ ...f, fullName: e.target.value }))}
              />
              <input
                className="input"
                type="email"
                placeholder="Email"
                value={form.email ?? ''}
                onChange={(e) => setForm((f: any) => ({ ...f, email: e.target.value }))}
              />
              <input
                className="input"
                type="password"
                placeholder="Password"
                value={form.password ?? ''}
                onChange={(e) => setForm((f: any) => ({ ...f, password: e.target.value }))}
              />
              <select
                className="input"
                value={form.role}
                onChange={(e) => setForm((f: any) => ({ ...f, role: e.target.value }))}
              >
                <option value="worker">Worker</option>
                <option value="admin">Admin</option>
              </select>
              <div className="flex justify-end gap-2">
                <button className="btn" onClick={() => setForm(null)}>
                  Cancel
                </button>
                <button className="btn btn-primary" disabled={busy} onClick={createUser}>
                  {busy ? 'Creating…' : 'Create user'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
