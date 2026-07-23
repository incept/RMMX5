'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

/** Voicemail drops: upload recordings, blast them to a list via the configured provider. */
export default function VoicemailPage() {
  const supabase = useMemo(() => createClient(), []);
  const [drops, setDrops] = useState<any[]>([]);
  const [lists, setLists] = useState<any[]>([]);
  const [sendForm, setSendForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [d, l] = await Promise.all([
      supabase
        .from('voicemail_drops')
        .select('*, voicemail_sends ( id, status )')
        .order('created_at', { ascending: false }),
      supabase.from('email_lists').select('id, name, email_list_members ( id )').order('name'),
    ]);
    setDrops(d.data ?? []);
    setLists(l.data ?? []);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function upload(file: File) {
    setBusy(true);
    const form = new FormData();
    form.append('file', file);
    form.append('name', file.name.replace(/\.[^.]+$/, ''));
    const res = await fetch('/api/voicemail/drops', { method: 'POST', body: form });
    setBusy(false);
    if (!res.ok) alert((await res.json()).error ?? 'Upload failed');
    load();
  }

  async function send() {
    if (!sendForm.listId) return alert('Choose a list');
    setBusy(true);
    const res = await fetch('/api/voicemail/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dropId: sendForm.dropId, listId: sendForm.listId }),
    });
    const data = await res.json();
    setBusy(false);
    if (res.ok) {
      alert(`Voicemail drop queued: ${data.sent} sent, ${data.failed} failed.`);
      setSendForm(null);
      load();
    } else alert(data.error ?? 'Send failed');
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Voicemail Drops</h1>
        <label className="btn btn-primary cursor-pointer">
          {busy ? 'Uploading…' : '⬆ Upload recording'}
          <input
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
        </label>
      </div>
      <p className="mb-4 text-xs text-gray-400">
        Ringless voicemail via the provider configured under Admin → Integrations. The provider
        fetches the audio from a signed URL.
      </p>

      <div className="space-y-2">
        {drops.map((d) => {
          const sent = d.voicemail_sends?.filter((s: any) => s.status === 'sent').length ?? 0;
          const failed = d.voicemail_sends?.filter((s: any) => s.status === 'failed').length ?? 0;
          return (
            <div key={d.id} className="card flex items-center gap-4">
              <span className="text-xl">🎙</span>
              <div className="flex-1">
                <div className="font-semibold">{d.name}</div>
                <div className="text-xs text-gray-400">
                  {new Date(d.created_at).toLocaleString()} · {sent} delivered
                  {failed ? ` · ${failed} failed` : ''}
                </div>
              </div>
              <button className="btn" onClick={() => setSendForm({ dropId: d.id, listId: '' })}>
                Send to list…
              </button>
              <button
                className="btn text-red-600"
                onClick={async () => {
                  if (!confirm(`Delete "${d.name}"?`)) return;
                  await supabase.from('voicemail_drops').delete().eq('id', d.id);
                  load();
                }}
              >
                Delete
              </button>
            </div>
          );
        })}
        {drops.length === 0 && (
          <div className="py-12 text-center text-sm text-gray-400">
            No recordings yet — upload an MP3/WAV to get started.
          </div>
        )}
      </div>

      {sendForm && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20" onClick={() => setSendForm(null)}>
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-3 text-sm font-semibold">Send voicemail drop</h2>
            <select
              className="input"
              value={sendForm.listId}
              onChange={(e) => setSendForm((f: any) => ({ ...f, listId: e.target.value }))}
            >
              <option value="">Choose list…</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.email_list_members?.length ?? 0} members)
                </option>
              ))}
            </select>
            <div className="mt-3 flex justify-end gap-2">
              <button className="btn" onClick={() => setSendForm(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={send}>
                {busy ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
