'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAutoRefresh } from '@/lib/use-auto-refresh';
import { useRealtimeRefresh } from '@/lib/use-realtime-refresh';

/**
 * Wraps a message body in a minimal HTML document whose base styles track the
 * app theme, so a sent message reads as part of the CRM instead of the bare
 * white / black / serif block a raw fragment renders as. Still injected into the
 * sandboxed iframe below (no scripts), so inbound mail that ships its own
 * styling renders as the sender built it — only the frame's defaults change.
 */
function framedEmail(html: string, dark: boolean): string {
  const bg = dark ? '#282c34' : '#ffffff'; // --color-surface, both themes
  const fg = dark ? '#f0f2f5' : '#111827'; // gray-900, both themes
  const link = dark ? '#a5b4fc' : '#4f46e5';
  const rule = dark ? '#474d59' : '#e5e7eb';
  const muted = dark ? '#b4bac3' : '#6b7280';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  :root { color-scheme: ${dark ? 'dark' : 'light'}; }
  html, body { margin: 0; }
  body {
    padding: 12px;
    background: ${bg};
    color: ${fg};
    font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.55;
    overflow-wrap: break-word;
  }
  a { color: ${link}; }
  img, table { max-width: 100%; }
  table { border-collapse: collapse; }
  blockquote {
    margin: 0 0 0 0.8em;
    padding-left: 0.8em;
    border-left: 3px solid ${rule};
    color: ${muted};
  }
</style></head><body>${html}</body></html>`;
}

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
  const [viewer, setViewer] = useState<{ id: string; role: string } | null>(null);
  const [showAccounts, setShowAccounts] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [compose, setCompose] = useState({
    to: '',
    subject: '',
    html: '',
    accountId: '',
    contactId: '',
    requestKey: '',
  });
  const [accountForm, setAccountForm] = useState<any>(null);
  const [imapTest, setImapTest] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  // Theme for the email preview frame; kept in sync with the <html class="dark">
  // toggle so switching light/dark re-renders the message in the matching palette.
  const [dark, setDark] = useState(false);

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
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();
      setViewer({ id: user.id, role: profile?.role ?? 'worker' });
    }

    // The safe view already excludes every secret (smtp_password, imap_password),
    // so `*` is safe here and picks up the IMAP fields the editor needs — without
    // a hand-maintained column list that silently drops newly-added columns (which
    // is exactly why saved IMAP settings appeared not to persist).
    const { data } = await supabase.from('email_accounts_safe').select('*').order('name');
    setAccounts(data ?? []);
  }, [supabase]);

  useEffect(() => {
    load();
    loadAccounts();
  }, [load, loadAccounts]);

  // Follow the app's light/dark class so the preview frame repaints on toggle.
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains('dark'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // New mail is there when you switch back to the tab, no manual reload, and
  // the Realtime subscription surfaces it while the inbox is open.
  useAutoRefresh(load);
  useRealtimeRefresh('email_messages', load);

  async function sendCompose() {
    if (!compose.to || !compose.subject) return alert('To and subject required');
    setBusy(true);
    const res = await fetch('/api/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': compose.requestKey },
      body: JSON.stringify({
        to: compose.to,
        subject: compose.subject,
        html: compose.html.replace(/\n/g, '<br/>'),
        accountId: compose.accountId || null,
        contactId: compose.contactId || null,
      }),
    });
    setBusy(false);
    if (res.ok) {
      setShowCompose(false);
      setCompose({
        to: '',
        subject: '',
        html: '',
        accountId: compose.accountId,
        contactId: '',
        requestKey: '',
      });
      load();
    } else alert((await res.json()).error ?? 'Send failed');
  }

  async function saveAccount() {
    const f = accountForm;
    if (!f.name || !f.from_email || !f.smtp_host || !f.smtp_username) {
      return alert('Name, from email, SMTP host and username are required');
    }
    if (!f.id && !f.smtp_password) {
      return alert('SMTP password is required for a new account');
    }
    const row: Record<string, any> = {
      name: f.name,
      from_name: f.from_name ?? '',
      from_email: f.from_email,
      smtp_host: f.smtp_host,
      smtp_port: Number(f.smtp_port ?? 587),
      smtp_username: f.smtp_username,
      smtp_secure: Number(f.smtp_port ?? 587) === 465,
      signature_html: f.signature_html ?? '',
      is_default: !!f.is_default,
      imap_host: f.imap_host ?? '',
      imap_port: Number(f.imap_port ?? 993),
      imap_username: f.imap_username ?? '',
      imap_enabled: !!f.imap_enabled,
      imap_allow_invalid_cert: !!f.imap_allow_invalid_cert,
    };
    // Passwords are write-only: include only when set (blank on edit = keep).
    if (f.smtp_password) row.smtp_password = f.smtp_password;
    if (f.imap_password) row.imap_password = f.imap_password;
    const res = await fetch(
      f.id ? `/api/admin/email-accounts/${encodeURIComponent(f.id)}` : '/api/admin/email-accounts',
      {
        method: f.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row),
      }
    );
    if (!res.ok) return alert((await res.json()).error ?? 'Could not save SMTP account');
    setAccountForm(null);
    loadAccounts();
  }

  // Validate IMAP credentials without saving: connect + list folders. Editing an
  // account can leave the password blank to reuse the stored one.
  async function testImap() {
    const f = accountForm;
    setImapTest({ busy: true });
    try {
      const res = await fetch('/api/admin/email-accounts/test-imap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: f.id ?? null,
          imap_host: f.imap_host,
          imap_port: Number(f.imap_port ?? 993),
          imap_username: f.imap_username,
          imap_password: f.imap_password,
          imap_allow_invalid_cert: !!f.imap_allow_invalid_cert,
        }),
      });
      setImapTest(await res.json());
    } catch {
      setImapTest({ ok: false, error: 'Request failed' });
    }
  }

  return (
    <div className="flex h-full">
      {/* Message list */}
      <div className="flex w-96 shrink-0 flex-col border-r border-gray-200 bg-white">
        <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3">
          <h1 className="text-2xl font-light tracking-tight">Inbox</h1>
          <select
            className="input ml-auto w-28 py-1"
            value={filter}
            onChange={(e) => setFilter(e.target.value as any)}
          >
            <option value="all">All</option>
            <option value="inbound">Received</option>
            <option value="outbound">Sent</option>
          </select>
          <button
            className="btn btn-primary py-1"
            onClick={() => {
              setCompose((current) => ({ ...current, contactId: '', requestKey: crypto.randomUUID() }));
              setShowCompose(true);
            }}
          >
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
            {/* Sandboxed iframe: inbound email HTML is attacker-controlled, so it
                must never run scripts or touch this origin's session. */}
            <iframe
              sandbox="allow-popups"
              srcDoc={framedEmail(selected.html ?? '', dark)}
              title="Email content"
              className="card mt-4 h-[60vh] w-full"
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
                    contactId: selected.contacts?.id ?? '',
                    requestKey: crypto.randomUUID(),
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
              {viewer && ['admin', 'super_admin'].includes(viewer.role) && (
                <button
                  className="btn btn-primary py-1"
                  onClick={() => {
                    setImapTest(null);
                    setAccountForm({
                      smtp_port: 587,
                      smtp_secure: false,
                      imap_port: 993,
                      imap_enabled: false,
                      is_default: accounts.length === 0,
                    });
                  }}
                >
                  + Add account
                </button>
              )}
            </div>

            {!accountForm &&
              accounts.map((a) => {
                const canManage = !!viewer && ['admin', 'super_admin'].includes(viewer.role);
                return (
                  <div key={a.id} className="mb-2 flex items-center gap-3 rounded-lg border border-gray-100 px-3 py-2 text-sm">
                    <div className="flex-1">
                      <div className="font-medium">
                        {a.name}{' '}
                        {a.is_default && <span className="text-xs text-brand-600">(default)</span>}
                      </div>
                      <div className="text-xs text-gray-400">
                        {a.from_email} via {a.smtp_host}:{a.smtp_port}
                      </div>
                    </div>
                    {canManage && (
                      <>
                        <button
                          className="btn py-1"
                          onClick={() => {
                            setImapTest(null);
                            setAccountForm(a);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          className="btn py-1 text-red-600"
                          onClick={async () => {
                            if (!confirm(`Delete account ${a.name}?`)) return;
                            const res = await fetch(
                              `/api/admin/email-accounts/${encodeURIComponent(a.id)}`,
                              { method: 'DELETE' }
                            );
                            if (!res.ok) {
                              alert((await res.json()).error ?? 'Could not delete SMTP account');
                              return;
                            }
                            loadAccounts();
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
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
                      placeholder={
                        key === 'smtp_password' && accountForm.id ? '•••••• (leave blank to keep)' : ''
                      }
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
                <div className="col-span-2 text-xs text-gray-500">
                  {Number(accountForm.smtp_port) === 465
                    ? 'Encryption: implicit TLS on connect (SSL) — standard for port 465.'
                    : 'Encryption: STARTTLS — selected automatically for ports 587 and 25.'}
                </div>
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
                <div className="col-span-2 mt-1 border-t border-gray-100 pt-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="label mb-0">Receiving (IMAP)</span>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={!!accountForm.imap_enabled}
                        onChange={(e) =>
                          setAccountForm((f: any) => ({ ...f, imap_enabled: e.target.checked }))
                        }
                      />
                      Enable receiving
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      ['imap_host', 'IMAP host'],
                      ['imap_port', 'IMAP port'],
                      ['imap_username', 'IMAP username'],
                      ['imap_password', 'IMAP password'],
                    ].map(([key, label]) => (
                      <div key={key}>
                        <label className="label">{label}</label>
                        <input
                          className="input"
                          type={key === 'imap_password' ? 'password' : 'text'}
                          placeholder={
                            key === 'imap_password' && accountForm.id
                              ? '•••••• (leave blank to keep)'
                              : ''
                          }
                          value={accountForm[key] ?? ''}
                          onChange={(e) =>
                            setAccountForm((f: any) => ({ ...f, [key]: e.target.value }))
                          }
                        />
                      </div>
                    ))}
                  </div>
                  <label className="mt-2 flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={!!accountForm.imap_allow_invalid_cert}
                      onChange={(e) =>
                        setAccountForm((f: any) => ({
                          ...f,
                          imap_allow_invalid_cert: e.target.checked,
                        }))
                      }
                    />
                    <span>
                      Accept the mailbox server certificate even if it does not match the hostname
                      (common on shared hosting like WPX — the exception a desktop client makes you
                      approve).
                    </span>
                  </label>
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      type="button"
                      className="btn py-1"
                      disabled={imapTest?.busy}
                      onClick={testImap}
                    >
                      {imapTest?.busy ? 'Testing…' : 'Test connection'}
                    </button>
                    {imapTest && !imapTest.busy && imapTest.ok && (
                      <span className="text-xs text-green-600">
                        Connected · {imapTest.folders?.length ?? 0} folders
                      </span>
                    )}
                    {imapTest && !imapTest.busy && imapTest.ok === false && (
                      <span className="text-xs text-red-600">{imapTest.error}</span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-gray-400">
                    Port 993 = implicit TLS, 143 = STARTTLS. Sending still uses the SMTP settings
                    above; IMAP is for receiving.
                  </p>
                </div>

                <div className="col-span-2 flex justify-end gap-2">
                  <button className="btn" onClick={() => { setImapTest(null); setAccountForm(null); }}>
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
