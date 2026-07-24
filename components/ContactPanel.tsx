'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import StatusPill, { type StatusOption } from '@/components/StatusPill';

const TABS = ['Contact Info', 'Link Data', 'Email', 'Data', 'Activity', 'Files'] as const;
type Tab = (typeof TABS)[number];

interface LinkSlot {
  position: number;
  url: string;
  status: 'live' | 'requested' | 'removed';
  difficulty: number | null;
}

const LINK_STATUS_COLORS: Record<string, string> = {
  live: '#EF4444',
  requested: '#F59E0B',
  removed: '#22C55E',
};

/** Slide-over panel with the Contact Info / Link Data / Email / Data tabs (+ Activity & Files). */
export default function ContactPanel({
  contactId,
  onClose,
  onChanged,
}: {
  contactId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [tab, setTab] = useState<Tab>('Contact Info');
  const [contact, setContact] = useState<any>(null);
  const [links, setLinks] = useState<LinkSlot[]>([]);
  const [statuses, setStatuses] = useState<StatusOption[]>([]);
  const [stages, setStages] = useState<any[]>([]);
  const [customFields, setCustomFields] = useState<any[]>([]);
  const [activity, setActivity] = useState<any[]>([]);
  const [files, setFiles] = useState<any[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [enrollments, setEnrollments] = useState<any[]>([]);
  const [listMemberships, setListMemberships] = useState<any[]>([]);
  const [allLists, setAllLists] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [defaultServiceDays, setDefaultServiceDays] = useState(90);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [compose, setCompose] = useState({ subject: '', html: '', accountId: '' });

  const load = useCallback(async () => {
    const [contactRes, linksRes, statusRes, stageRes, fieldsRes, activityRes] = await Promise.all([
      supabase
        .from('contacts')
        .select('*, statuses ( id, name, color, is_client_status ), stages ( id, name, color )')
        .eq('id', contactId)
        .single(),
      supabase.from('contact_links').select('*').eq('contact_id', contactId).order('position'),
      supabase.from('statuses').select('id, name, color, is_client_status').order('sort_order'),
      supabase.from('stages').select('id, name, color').order('sort_order'),
      supabase.from('custom_fields').select('*').order('sort_order'),
      supabase
        .from('activity_log')
        .select('*, profiles ( full_name, email )')
        .eq('contact_id', contactId)
        .order('created_at', { ascending: false })
        .limit(100),
    ]);

    setContact(contactRes.data);
    setStatuses(statusRes.data ?? []);
    setStages(stageRes.data ?? []);
    setCustomFields(fieldsRes.data ?? []);
    setActivity(activityRes.data ?? []);

    const slots: LinkSlot[] = Array.from({ length: 14 }, (_, i) => {
      const existing = (linksRes.data ?? []).find((l: any) => l.position === i + 1);
      return {
        position: i + 1,
        url: existing?.url ?? '',
        status: existing?.status ?? 'live',
        difficulty: existing?.difficulty ?? null,
      };
    });
    setLinks(slots);
  }, [supabase, contactId]);

  const loadEmailTab = useCallback(async () => {
    const [messagesRes, enrollRes, memberRes, listsRes, accountsRes] = await Promise.all([
      supabase
        .from('email_messages')
        .select('*')
        .eq('contact_id', contactId)
        .order('created_at', { ascending: false })
        .limit(30),
      supabase
        .from('sequence_enrollments')
        .select('*, email_sequences ( name )')
        .eq('contact_id', contactId),
      supabase
        .from('email_list_members')
        .select('id, list_id, email_lists ( name )')
        .eq('contact_id', contactId),
      supabase.from('email_lists').select('id, name').order('name'),
      supabase.from('email_accounts').select('id, name, from_email').order('name'),
    ]);
    setMessages(messagesRes.data ?? []);
    setEnrollments(enrollRes.data ?? []);
    setListMemberships(memberRes.data ?? []);
    setAllLists(listsRes.data ?? []);
    setAccounts(accountsRes.data ?? []);
  }, [supabase, contactId]);

  const loadFiles = useCallback(async () => {
    const res = await fetch(`/api/contacts/${contactId}/files`);
    if (res.ok) setFiles((await res.json()).files ?? []);
  }, [contactId]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (tab === 'Email') loadEmailTab();
    if (tab === 'Files') loadFiles();
  }, [tab, loadEmailTab, loadFiles]);

  async function patchContact(patch: Record<string, any>) {
    setBusy('save');
    const res = await fetch(`/api/contacts/${contactId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    setBusy(null);
    if (res.ok) {
      await load();
      onChanged();
    } else {
      alert((await res.json()).error ?? 'Save failed');
    }
  }

  async function saveLinks() {
    setBusy('links');
    const res = await fetch(`/api/contacts/${contactId}/links`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links }),
    });
    setBusy(null);
    if (res.ok) {
      await load();
      onChanged();
    } else {
      alert((await res.json()).error ?? 'Save failed');
    }
  }

  async function runSearch() {
    setBusy('search');
    const res = await fetch(`/api/contacts/${contactId}/search`, { method: 'POST' });
    const data = await res.json();
    setBusy(null);
    if (res.ok) {
      alert(
        `Search complete: ${data.total} results, ${data.relevant} relevant, ${data.inserted} link(s) added.`
      );
      await load();
      onChanged();
    } else {
      alert(data.error ?? 'Search failed');
    }
  }

  async function sendEmail() {
    if (!compose.subject || !compose.html) return alert('Subject and body required');
    setBusy('email');
    const res = await fetch('/api/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contactId,
        subject: compose.subject,
        html: compose.html.replace(/\n/g, '<br/>'),
        accountId: compose.accountId || null,
      }),
    });
    setBusy(null);
    if (res.ok) {
      setCompose({ subject: '', html: '', accountId: compose.accountId });
      loadEmailTab();
    } else {
      alert((await res.json()).error ?? 'Send failed');
    }
  }

  async function addNote() {
    if (!note.trim()) return;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    await supabase.from('activity_log').insert({
      contact_id: contactId,
      actor_id: user?.id ?? null,
      type: 'note',
      description: note.trim(),
    });
    setNote('');
    load();
  }

  async function uploadFile(file: File) {
    setBusy('file');
    const form = new FormData();
    form.append('file', file);
    await fetch(`/api/contacts/${contactId}/files`, { method: 'POST', body: form });
    setBusy(null);
    loadFiles();
  }

  function setField(key: string, value: any) {
    setContact((c: any) => ({ ...c, [key]: value }));
  }
  function setCustom(key: string, value: any) {
    setContact((c: any) => ({ ...c, custom: { ...(c.custom ?? {}), [key]: value } }));
  }

  const customFor = (tabKey: string) => customFields.filter((f) => f.tab === tabKey);

  const isClient = !!contact?.statuses?.is_client_status || !!contact?.client_since;
  const daysLeft = contact?.client_since
    ? (contact.service_days ?? defaultServiceDays) -
      Math.floor((Date.now() - new Date(contact.client_since).getTime()) / 86400000)
    : null;

  useEffect(() => {
    // default service days (admin setting) is not exposed to workers via settings
    // table RLS, so we just fall back to 90 client-side for display purposes.
    setDefaultServiceDays(90);
  }, []);

  if (!contact) return null;

  const input = (label: string, key: string, type = 'text', readOnly = false) => (
    <div>
      <label className="label">{label}</label>
      <input
        className="input"
        type={type}
        readOnly={readOnly}
        value={contact[key] ?? ''}
        onChange={(e) => setField(key, e.target.value)}
      />
    </div>
  );

  const customInputs = (tabKey: string) =>
    customFor(tabKey).map((field) => (
      <div key={field.id}>
        <label className="label">{field.label}</label>
        {field.field_type === 'select' ? (
          <select
            className="input"
            value={contact.custom?.[field.field_key] ?? ''}
            onChange={(e) => setCustom(field.field_key, e.target.value)}
          >
            <option value="">—</option>
            {(field.options ?? []).map((opt: string) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input"
            type={field.field_type === 'number' ? 'number' : field.field_type === 'date' ? 'date' : 'text'}
            value={contact.custom?.[field.field_key] ?? ''}
            onChange={(e) => setCustom(field.field_key, e.target.value)}
          />
        )}
      </div>
    ));

  const saveButton = (fields: string[]) => (
    <button
      className="btn btn-primary"
      disabled={busy === 'save'}
      onClick={() => {
        const patch: Record<string, any> = { custom: contact.custom };
        for (const f of fields) patch[f] = contact[f] === '' ? null : contact[f];
        patchContact(patch);
      }}
    >
      {busy === 'save' ? 'Saving…' : 'Save'}
    </button>
  );

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="border-b border-gray-200 px-5 pt-4">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-lg font-semibold">{contact.name}</h2>
              <div className="mt-1 flex items-center gap-2">
                <StatusPill
                  status={contact.statuses}
                  options={statuses}
                  onChange={(statusId) => patchContact({ status_id: statusId })}
                />
                {contact.reputation_score != null && (
                  <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium">
                    Rep {contact.reputation_score}
                  </span>
                )}
                {isClient && daysLeft != null && (
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      daysLeft <= 7 ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
                    }`}
                  >
                    ⏱ {daysLeft} day{daysLeft === 1 ? '' : 's'} left
                  </span>
                )}
                {contact.revenue_projection > 0 && (
                  <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">
                    Projected ${Number(contact.revenue_projection).toLocaleString()}
                  </span>
                )}
              </div>
            </div>
            <button className="btn btn-ghost" onClick={onClose}>
              ✕
            </button>
          </div>
          <div className="mt-3 flex gap-1 overflow-x-auto">
            {TABS.map((t) => (
              <button
                key={t}
                className={`panel-tab ${tab === t ? 'panel-tab-active' : ''}`}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'Contact Info' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                {input('Name', 'name')}
                {input('Email', 'email', 'email')}
                {input('Phone', 'phone')}
                {input('City', 'city')}
                {input('State', 'state')}
                <div>
                  <label className="label">Date created</label>
                  <input
                    className="input bg-gray-50"
                    readOnly
                    value={new Date(contact.created_at).toLocaleString()}
                  />
                </div>
                {isClient && (
                  <>
                    <div>
                      <label className="label">Client stage</label>
                      <select
                        className="input"
                        value={contact.stage_id ?? ''}
                        onChange={(e) => setField('stage_id', e.target.value || null)}
                      >
                        <option value="">—</option>
                        {stages.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="label">Service period (days)</label>
                      <input
                        className="input"
                        type="number"
                        value={contact.service_days ?? ''}
                        placeholder={String(defaultServiceDays)}
                        onChange={(e) =>
                          setField('service_days', e.target.value ? Number(e.target.value) : null)
                        }
                      />
                    </div>
                  </>
                )}
                {customInputs('contact')}
              </div>
              <div className="flex justify-between">
                {saveButton(['name', 'email', 'phone', 'city', 'state', 'stage_id', 'service_days'])}
                <button
                  className="btn text-red-600"
                  onClick={async () => {
                    if (!confirm('Delete this contact permanently?')) return;
                    const res = await fetch(`/api/contacts/${contactId}`, { method: 'DELETE' });
                    if (res.ok) {
                      onChanged();
                      onClose();
                    } else alert((await res.json()).error ?? 'Delete failed (admins only)');
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          )}

          {tab === 'Link Data' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="card flex-1 py-3 text-center">
                  <div className="text-2xl font-bold text-brand-700">
                    {contact.reputation_score ?? '—'}
                  </div>
                  <div className="text-xs text-gray-500">Reputation Score</div>
                </div>
                <div className="card flex-1 py-3 text-center">
                  <div className="text-2xl font-bold">{contact.link_score ?? '—'}</div>
                  <div className="text-xs text-gray-500">Link Score</div>
                </div>
                <div className="card flex-1 py-3 text-center">
                  <div className="text-2xl font-bold text-green-600">
                    ${Number(contact.revenue_projection ?? 0).toLocaleString()}
                  </div>
                  <div className="text-xs text-gray-500">Projected Revenue</div>
                </div>
              </div>

              <div className="space-y-1.5">
                {links.map((link, i) => (
                  <div key={link.position} className="flex items-center gap-2">
                    <span className="w-6 text-right font-mono text-xs text-gray-400">
                      {link.position}
                    </span>
                    <input
                      className="input flex-1"
                      placeholder={`Link ${link.position} URL`}
                      value={link.url}
                      onChange={(e) =>
                        setLinks((ls) =>
                          ls.map((l, j) => (j === i ? { ...l, url: e.target.value } : l))
                        )
                      }
                    />
                    <select
                      className="input w-32"
                      value={link.status}
                      style={{ color: LINK_STATUS_COLORS[link.status] }}
                      onChange={(e) =>
                        setLinks((ls) =>
                          ls.map((l, j) =>
                            j === i ? { ...l, status: e.target.value as LinkSlot['status'] } : l
                          )
                        )
                      }
                    >
                      <option value="live">Live</option>
                      <option value="requested">Requested</option>
                      <option value="removed">Removed</option>
                    </select>
                    <span
                      className="w-10 text-center text-xs text-gray-400"
                      title="Removal difficulty (from URL rules)"
                    >
                      {link.difficulty ? `D${link.difficulty}` : ''}
                    </span>
                  </div>
                ))}
              </div>
              {customFor('link').length > 0 && (
                <div className="grid grid-cols-2 gap-3">{customInputs('link')}</div>
              )}
              <div className="flex gap-2">
                <button className="btn btn-primary" disabled={busy === 'links'} onClick={saveLinks}>
                  {busy === 'links' ? 'Saving…' : 'Save links'}
                </button>
                {customFor('link').length > 0 && saveButton([])}
                <button className="btn" disabled={busy === 'search'} onClick={runSearch}>
                  {busy === 'search' ? 'Searching…' : '🔎 Run Google search'}
                </button>
              </div>
            </div>
          )}

          {tab === 'Email' && (
            <div className="space-y-5">
              <div>
                <div className="label">Email lists</div>
                <div className="flex flex-wrap items-center gap-2">
                  {listMemberships.map((m: any) => (
                    <span
                      key={m.id}
                      className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs"
                    >
                      {m.email_lists?.name}
                      <button
                        className="text-gray-400 hover:text-red-600"
                        onClick={async () => {
                          await supabase.from('email_list_members').delete().eq('id', m.id);
                          loadEmailTab();
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                  <select
                    className="input w-44"
                    value=""
                    onChange={async (e) => {
                      if (!e.target.value) return;
                      await supabase
                        .from('email_list_members')
                        .insert({ list_id: e.target.value, contact_id: contactId });
                      loadEmailTab();
                    }}
                  >
                    <option value="">+ Add to list…</option>
                    {allLists
                      .filter((l) => !listMemberships.some((m: any) => m.list_id === l.id))
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              <div>
                <div className="label">Current email sequences</div>
                {enrollments.length === 0 && (
                  <div className="text-sm text-gray-400">Not enrolled in any sequence.</div>
                )}
                {enrollments.map((e: any) => (
                  <div key={e.id} className="mb-1 flex items-center gap-2 text-sm">
                    <span className="font-medium">{e.email_sequences?.name}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        e.status === 'active'
                          ? 'bg-green-100 text-green-700'
                          : e.status === 'stopped'
                            ? 'bg-red-100 text-red-700'
                            : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {e.status}
                      {e.stop_reason ? ` (${e.stop_reason})` : ''}
                    </span>
                    <span className="text-xs text-gray-400">step {e.current_step}</span>
                  </div>
                ))}
              </div>

              <div>
                <div className="label">Engagement</div>
                <div className="flex gap-4 text-sm">
                  <span>📬 {messages.filter((m) => m.direction === 'outbound').length} sent</span>
                  <span>👁 {messages.reduce((n, m) => n + m.open_count, 0)} opens</span>
                  <span>🖱 {messages.reduce((n, m) => n + m.click_count, 0)} clicks</span>
                  <span>↩ {messages.filter((m) => m.replied || m.direction === 'inbound').length} replies</span>
                </div>
              </div>

              <div>
                <div className="label">Compose</div>
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
                    placeholder="Subject"
                    value={compose.subject}
                    onChange={(e) => setCompose((c) => ({ ...c, subject: e.target.value }))}
                  />
                  <textarea
                    className="input min-h-24"
                    placeholder="Message… ({{name}}, {{city}} placeholders work)"
                    value={compose.html}
                    onChange={(e) => setCompose((c) => ({ ...c, html: e.target.value }))}
                  />
                  <button className="btn btn-primary" disabled={busy === 'email'} onClick={sendEmail}>
                    {busy === 'email' ? 'Sending…' : 'Send email'}
                  </button>
                </div>
              </div>

              <div>
                <div className="label">History</div>
                <div className="space-y-1.5">
                  {messages.map((m) => (
                    <div key={m.id} className="rounded-lg border border-gray-100 px-3 py-2 text-sm">
                      <div className="flex items-center gap-2">
                        <span>{m.direction === 'outbound' ? '→' : '←'}</span>
                        <span className="flex-1 truncate font-medium">{m.subject}</span>
                        <span className="text-xs text-gray-400">
                          {new Date(m.created_at).toLocaleDateString()}
                        </span>
                      </div>
                      <div className="mt-0.5 flex gap-3 text-xs text-gray-400">
                        <span>{m.status}</span>
                        {m.open_count > 0 && <span>{m.open_count} opens</span>}
                        {m.click_count > 0 && <span>{m.click_count} clicks</span>}
                        {m.replied && <span className="text-green-600">replied</span>}
                        {m.bounced && <span className="text-red-600">bounced</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {customFor('email').length > 0 && (
                <div>
                  <div className="grid grid-cols-2 gap-3">{customInputs('email')}</div>
                  <div className="mt-2">{saveButton([])}</div>
                </div>
              )}
            </div>
          )}

          {tab === 'Data' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                {input('IP', 'ip')}
                {input('Browser', 'browser')}
                {input('Device', 'device')}
                {input('Source', 'source')}
                <div className="col-span-2">
                  <label className="label">Source URL</label>
                  <input
                    className="input"
                    value={contact.source_url ?? ''}
                    onChange={(e) => setField('source_url', e.target.value)}
                  />
                </div>
                {input('WordPress user', 'wp_user')}
                <div>
                  <label className="label">Submitted on</label>
                  <input
                    className="input bg-gray-50"
                    readOnly
                    value={
                      contact.submitted_at
                        ? new Date(contact.submitted_at).toLocaleString()
                        : '—'
                    }
                  />
                </div>
                {input('PPC KW', 'ppc_kw')}
                {input('UTM', 'utm')}
                <div>
                  <label className="label">Status</label>
                  <StatusPill
                    status={contact.statuses}
                    options={statuses}
                    onChange={(statusId) => patchContact({ status_id: statusId })}
                  />
                </div>
                {customInputs('data')}
              </div>
              {saveButton([
                'browser',
                'ppc_kw',
                'source',
                'ip',
                'utm',
                'device',
                'source_url',
                'wp_user',
              ])}
            </div>
          )}

          {tab === 'Activity' && (
            <div className="space-y-4">
              <div className="flex gap-2">
                <input
                  className="input"
                  placeholder="Add a note…"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addNote()}
                />
                <button className="btn btn-primary" onClick={addNote}>
                  Add
                </button>
              </div>
              <div className="space-y-2">
                {activity.map((a) => (
                  <div key={a.id} className="flex gap-3 text-sm">
                    <div className="w-32 shrink-0 text-xs text-gray-400">
                      {new Date(a.created_at).toLocaleString()}
                    </div>
                    <div>
                      <span className="mr-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-gray-500 uppercase">
                        {a.type}
                      </span>
                      {a.description}
                      {a.profiles && (
                        <span className="ml-1 text-xs text-gray-400">
                          — {a.profiles.full_name || a.profiles.email}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {activity.length === 0 && (
                  <div className="text-sm text-gray-400">No activity yet.</div>
                )}
              </div>
            </div>
          )}

          {tab === 'Files' && (
            <div className="space-y-4">
              <label className="btn btn-primary inline-block cursor-pointer">
                {busy === 'file' ? 'Uploading…' : '⬆ Upload file'}
                <input
                  type="file"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && uploadFile(e.target.files[0])}
                />
              </label>
              <div className="space-y-1.5">
                {files.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-center gap-3 rounded-lg border border-gray-100 px-3 py-2 text-sm"
                  >
                    <a
                      href={f.url ?? '#'}
                      target="_blank"
                      rel="noreferrer"
                      className="flex-1 truncate text-brand-600 hover:underline"
                    >
                      {f.name}
                    </a>
                    <span className="text-xs text-gray-400">
                      {(f.size_bytes / 1024).toFixed(0)} KB
                    </span>
                    <button
                      className="text-xs text-gray-400 hover:text-red-600"
                      onClick={async () => {
                        if (!confirm(`Delete ${f.name}?`)) return;
                        await fetch(`/api/contacts/${contactId}/files?fileId=${f.id}`, {
                          method: 'DELETE',
                        });
                        loadFiles();
                      }}
                    >
                      Delete
                    </button>
                  </div>
                ))}
                {files.length === 0 && <div className="text-sm text-gray-400">No files yet.</div>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
