'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

/**
 * Unified inbox: every inbound + outbound email across all SMTP accounts,
 * with a compose box (account picker; the account's signature is appended
 * automatically) and SMTP account management.
 */
export default function InboxPage() {
  const supabase = useMemo(() => createClient(), []);
  const [messages, setMessages] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [filter, setFilter] = useState<'all' | 'inbound' | 'outbound'>('all');
  const [accounts, setAccounts] = useState<any[]>([]);
  const [showAccounts, setShowAccounts] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [compose, setCompose] = useState({ to: '', subject: '', html: '', accountId: '' });
  const [accountForm, setAccountForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    let query = supabase
      .from('email_messages')
      .select('*, contacts ( id, name )')
      .order('created_at', { ascending: false })
      .limit(200);
    if (filter !== 'all') query = query.eq('direction', filter);
    const { data } = await query;
    setMessages(data ?? []);
  }, [supabase, filter]);

  const loadAccounts = useCallback(async () => {
    const { data } = await supabase.from('email_accounts').select('*').order('name');
    setAccounts(data ?? []);
  }, [supabase]);

  useEffect(() => {
    load();
    loadAccounts();
  }, [load, loadAccounts]);

  async function sendCompose() {
    if (!compose.to || !compose.subject) return alert('To and subject required');
    setBusy(true);
    const res = await fetch('/api/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: compose.to,
        subject: compose.subject,
        html: compose.html.replace(/\n/g, '<br/>'),
        accountId: compose.accountId || null,
      }),
    });
    setBusy(false);
    if (res.ok) {
      setShowCompose(false);
      setCompose({ to: '', subject: '', html: '', accountId: compose.accountId });
      load();
    } else alert((await res.json()).error ?? 'Send failed');
  }

  async function saveAccount() {
    const f = accountForm;
    if (!f.name || !f.from_email || !f.smtp_host || !f.smtp_username) {
      return alert('Name, from email, SMTP host and username are required');
    }
    const row = {
      name: f.name,
      from_name: f.from_name ?? '',
      from_email: f.from_email,
      smtp_host: f.smtp_host,
      smtp_port: Number(f.smtp_port ?? 587),
      smtp_username: f.smtp_username,
      smtp_password: f.smtp_password ?? '',
      smtp_secure: !!f.smtp_secure,
      signature_html: f.signature_html ?? '',
      is_default: !!f.is_default,
    };
    const { error } = f.id
      ? await supabase.from('email_accounts').update(row).eq('id', f.id)
      : await supabase.from('email_accounts').insert(row);
    if (error) return alert(error.message);
    setAccountForm(null);
    loadAccounts();
  }

  return (
    <div className="flex h-full">
      {/* Message list */}
      <div className="flex w-96 shrink-0 flex-col border-r border-gray-200 bg-white">
        <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3">
          <h1 className="text-lg font-semibold">Inbox</h1>
          <select
            className="input ml-auto w-28 py-1"
            value={filter}
            onChange={(e) => setFilter(e.target.value as any)}
          >
            <option value="all">All</option>
            <option value="inbound">Received</option>
            <option value="outbound">Sent</option>
          </select>
          <button className="btn btn-primary py-1" onClick={() => setShowCompose(true)}>
            ✎
          </button>
          <button className="btn py-1" title="SMTP accounts" onClick={() => setShowAccounts(true)}>
            ⚙
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {messages.map((m) => (
            <button
              key={m.id}
              onClick={() => setSelected(m)}
              className={`block w-full border-b border-gray-100 px-4 py-2.5 text-left hover:bg-gray-50 ${
                selected?.id === m.id ? 'bg-brand-50/50' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={m.direction === 'inbound' ? 'text-green-600' : 'text-gray-400'}>
                  {m.direction === 'inbound' ? '←' : '→'}
                </span>
                <span className="flex-1 truncate text-sm font-medium">
                  {m.contacts?.name ?? (m.direction === 'inbound' ? m.from_email : m.to_email)}
                </span>
                <span className="text-[10px] text-gray-400">
                  {new Date(m.created_at).toLocaleDateString()}
                </span>
              </div>
              <div className="mt-0.5 truncate text-xs text-gray-500">{m.subject}</div>
              <div className="mt-0.5 flex gap-2 text-[10px] text-gray-400">
                <span>{m.status}</span>
                {m.open_count > 0 && <span>👁 {m.open_count}</span>}
                {m.click_count > 0 && <span>🖱 {m.click_count}</span>}
                {m.replied && <span className="text-green-600">replied</span>}
                {m.bounced && <span className="text-red-600">bounced</span>}
              </div>
            </button>
          ))}
          {messages.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-gray-400">No messages yet.</div>
          )}
        </div>
      </div>

      {/* Reading pane */}
      <div className="flex-1 overflow-y-auto p-6">
        {selected ? (
          <div>
            <h2 className="text-lg font-semibold">{selected.subject}</h2>
            <div className="mt-1 text-sm text-gray-500">
              {selected.from_email} → {selected.to_email} ·{' '}
              {new Date(selected.created_at).toLocaleString()}
            </div>
            <div
              className="card mt-4 max-w-none text-sm"
              dangerouslySetInnerHTML={{ __html: selected.html }}
            />
            {selected.direction === 'inbound' && (
              <button
                className="btn mt-4"
                onClick={() => {
                  setCompose({
                    to: selected.from_email,
                    subject: `Re: ${selected.subject}`,
                    html: '',
                    accountId: '',
                  });
                  setShowCompose(true);
                }}
              >
                ↩ Reply
              </button>
            )}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-gray-400">
            Select a message
          </div>
        )}
      </div>

      {/* Compose modal */}
      {showCompose && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/20"
          onClick={() => setShowCompose(false)}
        >
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-3 text-sm font-semibold">New email</h2>
            <div className="space-y-2">
              {accounts.length > 0 && (
                <select
                  className="input"
                  value={compose.accountId}
                  onChange={(e) => setCompose((c) => ({ ...c, accountId: e.target.value }))}
                >
                  <option value="">Default account</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.from_email})
                    </option>
                  ))}
                </select>
              )}
              <input
                className="input"
                placeholder="To"
                value={compose.to}
                onChange={(e) => setCompose((c) => ({ ...c, to: e.target.value }))}
              />
              <input
                className="input"
                placeholder="Subject"
                value={compose.subject}
                onChange={(e) => setCompose((c) => ({ ...c, subject: e.target.value }))}
              />
              <textarea
                className="input min-h-32"
                placeholder="Message… (your account signature is added automatically)"
                value={compose.html}
                onChange={(e) => setCompose((c) => ({ ...c, html: e.target.value }))}
              />
              <div className="flex justify-end gap-2">
                <button className="btn" onClick={() => setShowCompose(false)}>
                  Cancel
                </button>
                <button className="btn btn-primary" disabled={busy} onClick={sendCompose}>
                  {busy ? 'Sending…' : 'Send'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Accounts modal */}
      {showAccounts && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/20"
          onClick={() => {
            setShowAccounts(false);
            setAccountForm(null);
          }}
        >
          <div
            className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-xl bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">SMTP accounts</h2>
              <button
                className="btn btn-primary py-1"
                onClick={() =>
                  setAccountForm({ smtp_port: 587, smtp_secure: false, is_default: accounts.length === 0 })
                }
              >
                + Add account
              </button>
            </div>

            {!accountForm &&
              accounts.map((a) => (
                <div key={a.id} className="mb-2 flex items-center gap-3 rounded-lg border border-gray-100 px-3 py-2 text-sm">
                  <div className="flex-1">
                    <div className="font-medium">
                      {a.name} {a.is_default && <span className="text-xs text-brand-600">(default)</span>}
                    </div>
                    <div className="text-xs text-gray-400">
                      {a.from_email} via {a.smtp_host}:{a.smtp_port}
                    </div>
                  </div>
                  <button className="btn py-1" onClick={() => setAccountForm(a)}>
                    Edit
                  </button>
                  <button
                    className="btn py-1 text-red-600"
                    onClick={async () => {
                      if (!confirm(`Delete account ${a.name}?`)) return;
                      await supabase.from('email_accounts').delete().eq('id', a.id);
                      loadAccounts();
                    }}
                  >
                    Delete
                  </button>
                </div>
              ))}
            {!accountForm && accounts.length === 0 && (
              <div className="py-6 text-center text-sm text-gray-400">
                No SMTP accounts yet. Without one, sends fall back to the Emailit API key.
              </div>
            )}

            {accountForm && (
              <div className="grid grid-cols-2 gap-2">
                {[
                  ['name', 'Account name'],
                  ['from_name', 'From name'],
                  ['from_email', 'From email'],
                  ['smtp_host', 'SMTP host'],
                  ['smtp_port', 'SMTP port'],
                  ['smtp_username', 'SMTP username'],
                  ['smtp_password', 'SMTP password'],
                ].map(([key, label]) => (
                  <div key={key}>
                    <label className="label">{label}</label>
                    <input
                      className="input"
                      type={key === 'smtp_password' ? 'password' : 'text'}
                      value={accountForm[key] ?? ''}
                      onChange={(e) => setAccountForm((f: any) => ({ ...f, [key]: e.target.value }))}
                    />
                  </div>
                ))}
                <div className="col-span-2">
                  <label className="label">Signature (HTML)</label>
                  <textarea
                    className="input min-h-20"
                    value={accountForm.signature_html ?? ''}
                    onChange={(e) =>
                      setAccountForm((f: any) => ({ ...f, signature_html: e.target.value }))
                    }
                  />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!accountForm.smtp_secure}
                    onChange={(e) =>
                      setAccountForm((f: any) => ({ ...f, smtp_secure: e.target.checked }))
                    }
                  />
                  TLS on connect (port 465)
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!accountForm.is_default}
                    onChange={(e) =>
                      setAccountForm((f: any) => ({ ...f, is_default: e.target.checked }))
                    }
                  />
                  Default account
                </label>
                <div className="col-span-2 flex justify-end gap-2">
                  <button className="btn" onClick={() => setAccountForm(null)}>
                    Cancel
                  </button>
                  <button className="btn btn-primary" onClick={saveAccount}>
                    Save account
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
