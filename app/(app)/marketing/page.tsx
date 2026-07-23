'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

const TABS = ['Sequences', 'Templates', 'Lists', 'Analytics'] as const;
type Tab = (typeof TABS)[number];

const STOP_TRIGGERS = ['open', 'click', 'reply', 'bounce', 'status_change'] as const;

/** Email marketing hub: templates, lists, sequences (with start/stop triggers), analytics. */
export default function MarketingPage() {
  const supabase = useMemo(() => createClient(), []);
  const [tab, setTab] = useState<Tab>('Sequences');

  const [templates, setTemplates] = useState<any[]>([]);
  const [lists, setLists] = useState<any[]>([]);
  const [sequences, setSequences] = useState<any[]>([]);
  const [statuses, setStatuses] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [analytics, setAnalytics] = useState<any[]>([]);
  const [analyticsSort, setAnalyticsSort] = useState<'open_count' | 'click_count' | 'created_at'>('open_count');

  const [templateForm, setTemplateForm] = useState<any>(null);
  const [listForm, setListForm] = useState<any>(null);
  const [sequenceForm, setSequenceForm] = useState<any>(null);
  const [blast, setBlast] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [t, l, s, st, a] = await Promise.all([
      supabase.from('email_templates').select('*').order('name'),
      supabase.from('email_lists').select('*, email_list_members ( id )').order('name'),
      supabase
        .from('email_sequences')
        .select('*, email_lists ( name ), sequence_steps ( * ), sequence_enrollments ( id, status )')
        .order('name'),
      supabase.from('statuses').select('id, name, color').order('sort_order'),
      supabase.from('email_accounts').select('id, name, from_email').order('name'),
    ]);
    setTemplates(t.data ?? []);
    setLists(l.data ?? []);
    setSequences(s.data ?? []);
    setStatuses(st.data ?? []);
    setAccounts(a.data ?? []);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (tab !== 'Analytics') return;
    supabase
      .from('email_messages')
      .select('*, contacts ( name )')
      .eq('direction', 'outbound')
      .order(analyticsSort, { ascending: false })
      .limit(200)
      .then(({ data }) => setAnalytics(data ?? []));
  }, [tab, analyticsSort, supabase]);

  // ---- Template CRUD -------------------------------------------------------
  async function saveTemplate() {
    const f = templateForm;
    if (!f.name) return alert('Name required');
    const row = { name: f.name, subject: f.subject ?? '', html: f.html ?? '' };
    const { error } = f.id
      ? await supabase.from('email_templates').update(row).eq('id', f.id)
      : await supabase.from('email_templates').insert(row);
    if (error) return alert(error.message);
    setTemplateForm(null);
    load();
  }

  // ---- List CRUD -----------------------------------------------------------
  async function saveList() {
    const f = listForm;
    if (!f.name) return alert('Name required');
    const row = { name: f.name, description: f.description ?? null };
    const { error } = f.id
      ? await supabase.from('email_lists').update(row).eq('id', f.id)
      : await supabase.from('email_lists').insert(row);
    if (error) return alert(error.message);
    setListForm(null);
    load();
  }

  // ---- Sequence CRUD -------------------------------------------------------
  function newSequence() {
    setSequenceForm({
      name: '',
      list_id: '',
      send_account_id: '',
      active: false,
      start_trigger: 'manual',
      start_status_ids: [],
      stop_on: ['reply', 'bounce'],
      stop_status_ids: [],
      steps: [{ template_id: '', delay_days: 0 }],
    });
  }

  function editSequence(seq: any) {
    setSequenceForm({
      ...seq,
      list_id: seq.list_id ?? '',
      send_account_id: seq.send_account_id ?? '',
      steps: [...(seq.sequence_steps ?? [])]
        .sort((a: any, b: any) => a.step_order - b.step_order)
        .map((s: any) => ({ template_id: s.template_id ?? '', delay_days: s.delay_days })),
    });
  }

  async function saveSequence() {
    const f = sequenceForm;
    if (!f.name) return alert('Name required');
    setBusy(true);

    const row = {
      name: f.name,
      list_id: f.list_id || null,
      send_account_id: f.send_account_id || null,
      active: !!f.active,
      start_trigger: f.start_trigger,
      start_status_ids: f.start_status_ids ?? [],
      stop_on: f.stop_on ?? [],
      stop_status_ids: f.stop_status_ids ?? [],
    };

    let sequenceId = f.id;
    if (sequenceId) {
      const { error } = await supabase.from('email_sequences').update(row).eq('id', sequenceId);
      if (error) {
        setBusy(false);
        return alert(error.message);
      }
      await supabase.from('sequence_steps').delete().eq('sequence_id', sequenceId);
    } else {
      const { data, error } = await supabase.from('email_sequences').insert(row).select('id').single();
      if (error || !data) {
        setBusy(false);
        return alert(error?.message ?? 'save failed');
      }
      sequenceId = data.id;
    }

    const steps = (f.steps ?? [])
      .filter((s: any) => s.template_id)
      .map((s: any, i: number) => ({
        sequence_id: sequenceId,
        step_order: i + 1,
        template_id: s.template_id,
        delay_days: Number(s.delay_days ?? 0),
      }));
    if (steps.length) await supabase.from('sequence_steps').insert(steps);

    setBusy(false);
    setSequenceForm(null);
    load();
  }

  async function enrollList(seq: any) {
    if (!seq.list_id) return alert('This sequence has no list attached.');
    if (!confirm(`Enroll every member of "${seq.email_lists?.name}" into "${seq.name}"?`)) return;
    const res = await fetch(`/api/email/sequences/${seq.id}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wholeList: true }),
    });
    const data = await res.json();
    if (res.ok) {
      alert(`Enrolled ${data.enrolled} contact(s).`);
      load();
    } else alert(data.error ?? 'Enroll failed');
  }

  async function sendBlast() {
    if (!blast.listId || !blast.subject) return alert('List and subject required');
    setBusy(true);
    const res = await fetch('/api/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        listId: blast.listId,
        subject: blast.subject,
        html: (blast.html ?? '').replace(/\n/g, '<br/>'),
        accountId: blast.accountId || null,
      }),
    });
    const data = await res.json();
    setBusy(false);
    if (res.ok) {
      alert(`Sent ${data.sent}, failed ${data.failed}.`);
      setBlast(null);
    } else alert(data.error ?? 'Send failed');
  }

  const toggleInArray = (arr: string[], value: string) =>
    arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-4">
        <h1 className="text-lg font-semibold">Email Marketing</h1>
        <div className="flex gap-1">
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

      {/* ---------------- Sequences ---------------- */}
      {tab === 'Sequences' && !sequenceForm && (
        <div>
          <button className="btn btn-primary mb-4" onClick={newSequence}>
            + New sequence
          </button>
          <div className="grid gap-3 lg:grid-cols-2">
            {sequences.map((seq) => {
              const active = seq.sequence_enrollments?.filter((e: any) => e.status === 'active').length ?? 0;
              return (
                <div key={seq.id} className="card">
                  <div className="flex items-center justify-between">
                    <div className="font-semibold">{seq.name}</div>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        seq.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {seq.active ? 'Active' : 'Paused'}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    List: {seq.email_lists?.name ?? '—'} · {seq.sequence_steps?.length ?? 0} steps ·{' '}
                    {active} active enrollment{active === 1 ? '' : 's'}
                  </div>
                  <div className="mt-1 text-xs text-gray-400">
                    Starts: {seq.start_trigger.replace('_', ' ')} · Stops on:{' '}
                    {(seq.stop_on ?? []).join(', ') || 'nothing'}
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button className="btn py-1" onClick={() => editSequence(seq)}>
                      Edit
                    </button>
                    <button className="btn py-1" onClick={() => enrollList(seq)}>
                      Enroll list
                    </button>
                    <button
                      className="btn py-1"
                      onClick={async () => {
                        await supabase
                          .from('email_sequences')
                          .update({ active: !seq.active })
                          .eq('id', seq.id);
                        load();
                      }}
                    >
                      {seq.active ? 'Pause' : 'Activate'}
                    </button>
                  </div>
                </div>
              );
            })}
            {sequences.length === 0 && (
              <div className="col-span-2 py-12 text-center text-sm text-gray-400">
                No sequences yet. Sequences send templates to a list with configurable day delays,
                and stop automatically on opens, clicks, replies, bounces, or status changes.
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'Sequences' && sequenceForm && (
        <div className="card max-w-3xl">
          <h2 className="mb-3 text-sm font-semibold">
            {sequenceForm.id ? 'Edit sequence' : 'New sequence'}
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Name</label>
              <input
                className="input"
                value={sequenceForm.name}
                onChange={(e) => setSequenceForm((f: any) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div>
              <label className="label">List</label>
              <select
                className="input"
                value={sequenceForm.list_id}
                onChange={(e) => setSequenceForm((f: any) => ({ ...f, list_id: e.target.value }))}
              >
                <option value="">— none —</option>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Send from</label>
              <select
                className="input"
                value={sequenceForm.send_account_id}
                onChange={(e) =>
                  setSequenceForm((f: any) => ({ ...f, send_account_id: e.target.value }))
                }
              >
                <option value="">Default account</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.from_email})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Start trigger</label>
              <select
                className="input"
                value={sequenceForm.start_trigger}
                onChange={(e) =>
                  setSequenceForm((f: any) => ({ ...f, start_trigger: e.target.value }))
                }
              >
                <option value="manual">Manual enrollment</option>
                <option value="status_change">On status change</option>
                <option value="list_added">When added to list (manual enroll also works)</option>
              </select>
            </div>
          </div>

          {sequenceForm.start_trigger === 'status_change' && (
            <div className="mt-3">
              <label className="label">Start when status becomes</label>
              <div className="flex flex-wrap gap-1.5">
                {statuses.map((s) => (
                  <button
                    key={s.id}
                    onClick={() =>
                      setSequenceForm((f: any) => ({
                        ...f,
                        start_status_ids: toggleInArray(f.start_status_ids ?? [], s.id),
                      }))
                    }
                    className="rounded-full px-2.5 py-0.5 text-xs"
                    style={
                      (sequenceForm.start_status_ids ?? []).includes(s.id)
                        ? { backgroundColor: s.color, color: '#fff' }
                        : { backgroundColor: '#f3f4f6', color: '#6b7280' }
                    }
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-3">
            <label className="label">Stop sending when contact…</label>
            <div className="flex flex-wrap gap-1.5">
              {STOP_TRIGGERS.map((trigger) => (
                <button
                  key={trigger}
                  onClick={() =>
                    setSequenceForm((f: any) => ({
                      ...f,
                      stop_on: toggleInArray(f.stop_on ?? [], trigger),
                    }))
                  }
                  className={`rounded-full px-2.5 py-0.5 text-xs ${
                    (sequenceForm.stop_on ?? []).includes(trigger)
                      ? 'bg-red-600 text-white'
                      : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {trigger.replace('_', ' ')}s
                </button>
              ))}
            </div>
          </div>

          {(sequenceForm.stop_on ?? []).includes('status_change') && (
            <div className="mt-3">
              <label className="label">…changes status to (empty = any status)</label>
              <div className="flex flex-wrap gap-1.5">
                {statuses.map((s) => (
                  <button
                    key={s.id}
                    onClick={() =>
                      setSequenceForm((f: any) => ({
                        ...f,
                        stop_status_ids: toggleInArray(f.stop_status_ids ?? [], s.id),
                      }))
                    }
                    className="rounded-full px-2.5 py-0.5 text-xs"
                    style={
                      (sequenceForm.stop_status_ids ?? []).includes(s.id)
                        ? { backgroundColor: s.color, color: '#fff' }
                        : { backgroundColor: '#f3f4f6', color: '#6b7280' }
                    }
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4">
            <label className="label">Steps</label>
            {(sequenceForm.steps ?? []).map((step: any, i: number) => (
              <div key={i} className="mb-2 flex items-center gap-2">
                <span className="w-6 text-right font-mono text-xs text-gray-400">{i + 1}</span>
                <select
                  className="input flex-1"
                  value={step.template_id}
                  onChange={(e) =>
                    setSequenceForm((f: any) => ({
                      ...f,
                      steps: f.steps.map((s: any, j: number) =>
                        j === i ? { ...s, template_id: e.target.value } : s
                      ),
                    }))
                  }
                >
                  <option value="">Choose template…</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-gray-400">wait</span>
                <input
                  className="input w-20"
                  type="number"
                  min={0}
                  value={step.delay_days}
                  onChange={(e) =>
                    setSequenceForm((f: any) => ({
                      ...f,
                      steps: f.steps.map((s: any, j: number) =>
                        j === i ? { ...s, delay_days: e.target.value } : s
                      ),
                    }))
                  }
                />
                <span className="text-xs text-gray-400">days</span>
                <button
                  className="btn btn-ghost py-1 text-red-500"
                  onClick={() =>
                    setSequenceForm((f: any) => ({
                      ...f,
                      steps: f.steps.filter((_: any, j: number) => j !== i),
                    }))
                  }
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              className="btn py-1"
              onClick={() =>
                setSequenceForm((f: any) => ({
                  ...f,
                  steps: [...(f.steps ?? []), { template_id: '', delay_days: 2 }],
                }))
              }
            >
              + Add step
            </button>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!sequenceForm.active}
                onChange={(e) => setSequenceForm((f: any) => ({ ...f, active: e.target.checked }))}
              />
              Active (cron sends due steps)
            </label>
            <div className="flex gap-2">
              {sequenceForm.id && (
                <button
                  className="btn text-red-600"
                  onClick={async () => {
                    if (!confirm('Delete this sequence and its enrollments?')) return;
                    await supabase.from('email_sequences').delete().eq('id', sequenceForm.id);
                    setSequenceForm(null);
                    load();
                  }}
                >
                  Delete
                </button>
              )}
              <button className="btn" onClick={() => setSequenceForm(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={saveSequence}>
                {busy ? 'Saving…' : 'Save sequence'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------------- Templates ---------------- */}
      {tab === 'Templates' && (
        <div>
          <button
            className="btn btn-primary mb-4"
            onClick={() => setTemplateForm({ name: '', subject: '', html: '' })}
          >
            + New template
          </button>
          <div className="grid gap-3 lg:grid-cols-3">
            {templates.map((t) => (
              <div key={t.id} className="card">
                <div className="font-semibold">{t.name}</div>
                <div className="mt-1 truncate text-xs text-gray-500">{t.subject}</div>
                <div className="mt-2 line-clamp-3 text-xs text-gray-400">
                  {t.html.replace(/<[^>]+>/g, ' ')}
                </div>
                <button className="btn mt-3 py-1" onClick={() => setTemplateForm(t)}>
                  Edit
                </button>
              </div>
            ))}
          </div>

          {templateForm && (
            <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20" onClick={() => setTemplateForm(null)}>
              <div className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                <h2 className="mb-3 text-sm font-semibold">
                  {templateForm.id ? 'Edit template' : 'New template'}
                </h2>
                <div className="space-y-2">
                  <input
                    className="input"
                    placeholder="Template name"
                    value={templateForm.name}
                    onChange={(e) => setTemplateForm((f: any) => ({ ...f, name: e.target.value }))}
                  />
                  <input
                    className="input"
                    placeholder="Subject — {{name}}, {{city}} placeholders work"
                    value={templateForm.subject}
                    onChange={(e) => setTemplateForm((f: any) => ({ ...f, subject: e.target.value }))}
                  />
                  <textarea
                    className="input min-h-48 font-mono text-xs"
                    placeholder="HTML body… use {{name}}, {{city}}, {{state}} and custom-field keys"
                    value={templateForm.html}
                    onChange={(e) => setTemplateForm((f: any) => ({ ...f, html: e.target.value }))}
                  />
                  <div className="flex justify-between">
                    {templateForm.id ? (
                      <button
                        className="btn text-red-600"
                        onClick={async () => {
                          if (!confirm('Delete this template?')) return;
                          await supabase.from('email_templates').delete().eq('id', templateForm.id);
                          setTemplateForm(null);
                          load();
                        }}
                      >
                        Delete
                      </button>
                    ) : (
                      <span />
                    )}
                    <div className="flex gap-2">
                      <button className="btn" onClick={() => setTemplateForm(null)}>
                        Cancel
                      </button>
                      <button className="btn btn-primary" onClick={saveTemplate}>
                        Save
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---------------- Lists ---------------- */}
      {tab === 'Lists' && (
        <div>
          <div className="mb-4 flex gap-2">
            <button className="btn btn-primary" onClick={() => setListForm({ name: '' })}>
              + New list
            </button>
            <button className="btn" onClick={() => setBlast({ listId: '', subject: '', html: '' })}>
              ✉ Send one-off blast
            </button>
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            {lists.map((l) => (
              <div key={l.id} className="card">
                <div className="font-semibold">{l.name}</div>
                <div className="mt-1 text-xs text-gray-500">
                  {l.email_list_members?.length ?? 0} member
                  {(l.email_list_members?.length ?? 0) === 1 ? '' : 's'}
                </div>
                {l.description && <div className="mt-1 text-xs text-gray-400">{l.description}</div>}
                <div className="mt-3 flex gap-2">
                  <button className="btn py-1" onClick={() => setListForm(l)}>
                    Edit
                  </button>
                </div>
              </div>
            ))}
            {lists.length === 0 && (
              <div className="col-span-3 py-12 text-center text-sm text-gray-400">
                No lists yet. Add contacts to lists from the contact panel's Email tab.
              </div>
            )}
          </div>

          {listForm && (
            <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20" onClick={() => setListForm(null)}>
              <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                <h2 className="mb-3 text-sm font-semibold">{listForm.id ? 'Edit list' : 'New list'}</h2>
                <div className="space-y-2">
                  <input
                    className="input"
                    placeholder="List name"
                    value={listForm.name}
                    onChange={(e) => setListForm((f: any) => ({ ...f, name: e.target.value }))}
                  />
                  <input
                    className="input"
                    placeholder="Description"
                    value={listForm.description ?? ''}
                    onChange={(e) => setListForm((f: any) => ({ ...f, description: e.target.value }))}
                  />
                  <div className="flex justify-between">
                    {listForm.id ? (
                      <button
                        className="btn text-red-600"
                        onClick={async () => {
                          if (!confirm('Delete this list?')) return;
                          await supabase.from('email_lists').delete().eq('id', listForm.id);
                          setListForm(null);
                          load();
                        }}
                      >
                        Delete
                      </button>
                    ) : (
                      <span />
                    )}
                    <div className="flex gap-2">
                      <button className="btn" onClick={() => setListForm(null)}>
                        Cancel
                      </button>
                      <button className="btn btn-primary" onClick={saveList}>
                        Save
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {blast && (
            <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20" onClick={() => setBlast(null)}>
              <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                <h2 className="mb-3 text-sm font-semibold">One-off blast</h2>
                <div className="space-y-2">
                  <select
                    className="input"
                    value={blast.listId}
                    onChange={(e) => setBlast((b: any) => ({ ...b, listId: e.target.value }))}
                  >
                    <option value="">Choose list…</option>
                    {lists.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} ({l.email_list_members?.length ?? 0})
                      </option>
                    ))}
                  </select>
                  {accounts.length > 0 && (
                    <select
                      className="input"
                      value={blast.accountId ?? ''}
                      onChange={(e) => setBlast((b: any) => ({ ...b, accountId: e.target.value }))}
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
                    value={blast.subject}
                    onChange={(e) => setBlast((b: any) => ({ ...b, subject: e.target.value }))}
                  />
                  <textarea
                    className="input min-h-32"
                    placeholder="Message… ({{name}} placeholders work)"
                    value={blast.html}
                    onChange={(e) => setBlast((b: any) => ({ ...b, html: e.target.value }))}
                  />
                  <div className="flex justify-end gap-2">
                    <button className="btn" onClick={() => setBlast(null)}>
                      Cancel
                    </button>
                    <button className="btn btn-primary" disabled={busy} onClick={sendBlast}>
                      {busy ? 'Sending…' : 'Send now'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---------------- Analytics ---------------- */}
      {tab === 'Analytics' && (
        <div>
          <div className="mb-3 flex items-center gap-2 text-sm">
            <span className="text-gray-500">Sort by</span>
            {(
              [
                ['open_count', 'Opens'],
                ['click_count', 'Clicks'],
                ['created_at', 'Newest'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className={`btn py-1 ${analyticsSort === key ? 'btn-primary' : ''}`}
                onClick={() => setAnalyticsSort(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="card p-0">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="grid-th">Contact</th>
                  <th className="grid-th">Subject</th>
                  <th className="grid-th">Opens</th>
                  <th className="grid-th">Clicks</th>
                  <th className="grid-th">Replied</th>
                  <th className="grid-th">Bounced</th>
                  <th className="grid-th">Sent</th>
                </tr>
              </thead>
              <tbody>
                {analytics.map((m) => (
                  <tr key={m.id}>
                    <td className="grid-td font-medium">{m.contacts?.name ?? m.to_email}</td>
                    <td className="grid-td max-w-64 truncate text-gray-500">{m.subject}</td>
                    <td className="grid-td font-mono">{m.open_count}</td>
                    <td className="grid-td font-mono">{m.click_count}</td>
                    <td className="grid-td">{m.replied ? '✓' : ''}</td>
                    <td className="grid-td text-red-600">{m.bounced ? '✕' : ''}</td>
                    <td className="grid-td text-gray-400">
                      {m.sent_at ? new Date(m.sent_at).toLocaleString() : m.status}
                    </td>
                  </tr>
                ))}
                {analytics.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-sm text-gray-400">
                      No outbound email yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
