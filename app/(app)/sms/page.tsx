'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

/** SMS campaigns via TextLink: create a campaign against a list and send. */
export default function SmsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [lists, setLists] = useState<any[]>([]);
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [c, l] = await Promise.all([
      supabase
        .from('sms_campaigns')
        .select('*, email_lists ( name ), sms_messages ( id, status )')
        .order('created_at', { ascending: false }),
      supabase.from('email_lists').select('id, name, email_list_members ( id )').order('name'),
    ]);
    setCampaigns(c.data ?? []);
    setLists(l.data ?? []);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function submit(sendNow: boolean) {
    if (!form.name || !form.body || !form.listId) return alert('Name, message and list required');
    setBusy(true);
    const res = await fetch('/api/sms/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, sendNow }),
    });
    const data = await res.json();
    setBusy(false);
    if (res.ok) {
      setForm(null);
      load();
      if (sendNow) alert(`Sent ${data.campaign.sent_count ?? 0}, failed ${data.campaign.failed_count ?? 0}.`);
    } else alert(data.error ?? 'Failed');
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-lg font-semibold">SMS Campaigns</h1>
        <button
          className="btn btn-primary"
          onClick={() =>
            setForm({ name: '', body: '', listId: '', idempotencyKey: crypto.randomUUID() })
          }
        >
          + New campaign
        </button>
      </div>
      <p className="mb-4 text-xs text-gray-400">
        Sends via TextLink (a paired Android device with an active SIM must be online). Configure
        the API key under Admin → Integrations.
      </p>

      <div className="space-y-2">
        {campaigns.map((c) => (
          <div key={c.id} className="card flex items-center gap-4">
            <div className="flex-1">
              <div className="font-semibold">{c.name}</div>
              <div className="mt-0.5 line-clamp-1 text-xs text-gray-500">{c.body}</div>
              <div className="mt-0.5 text-xs text-gray-400">
                List: {c.email_lists?.name ?? '—'} · {new Date(c.created_at).toLocaleString()}
              </div>
            </div>
            <div className="text-right text-xs">
              <span
                className={`rounded-full px-2.5 py-0.5 font-medium ${
                  c.status === 'sent'
                    ? 'bg-green-100 text-green-700'
                    : c.status === 'failed'
                      ? 'bg-red-100 text-red-700'
                      : c.status === 'sending'
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-gray-100 text-gray-500'
                }`}
              >
                {c.status}
              </span>
              <div className="mt-1 text-gray-400">
                {c.sent_count} sent{c.failed_count ? ` · ${c.failed_count} failed` : ''}
              </div>
            </div>
          </div>
        ))}
        {campaigns.length === 0 && (
          <div className="py-12 text-center text-sm text-gray-400">No campaigns yet.</div>
        )}
      </div>

      {form && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20" onClick={() => setForm(null)}>
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-3 text-sm font-semibold">New SMS campaign</h2>
            <div className="space-y-2">
              <input
                className="input"
                placeholder="Campaign name"
                value={form.name}
                onChange={(e) => setForm((f: any) => ({ ...f, name: e.target.value }))}
              />
              <select
                className="input"
                value={form.listId}
                onChange={(e) => setForm((f: any) => ({ ...f, listId: e.target.value }))}
              >
                <option value="">Choose list…</option>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.email_list_members?.length ?? 0} members)
                  </option>
                ))}
              </select>
              <textarea
                className="input min-h-28"
                placeholder="Message… ({{name}} placeholders work)"
                maxLength={480}
                value={form.body}
                onChange={(e) => setForm((f: any) => ({ ...f, body: e.target.value }))}
              />
              <div className="text-right text-xs text-gray-400">{form.body.length}/480</div>
              <div className="flex justify-end gap-2">
                <button className="btn" onClick={() => setForm(null)}>
                  Cancel
                </button>
                <button className="btn" disabled={busy} onClick={() => submit(false)}>
                  Save draft
                </button>
                <button className="btn btn-primary" disabled={busy} onClick={() => submit(true)}>
                  {busy ? 'Sending…' : 'Send now'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
