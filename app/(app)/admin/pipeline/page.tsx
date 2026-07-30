'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

/** Admin: lead statuses (with colors) and client stages, both fully editable. */
export default function PipelinePage() {
  const supabase = useMemo(() => createClient(), []);
  const [statuses, setStatuses] = useState<any[]>([]);
  const [stages, setStages] = useState<any[]>([]);
  // The delete-a-status dialog: who is inside, and where they go.
  const [deleting, setDeleting] = useState<{ row: any; count: number } | null>(null);
  const [moveTo, setMoveTo] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [st, sg] = await Promise.all([
      supabase.from('statuses').select('*').order('sort_order'),
      supabase.from('stages').select('*').order('sort_order'),
    ]);
    setStatuses(st.data ?? []);
    setStages(sg.data ?? []);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function deleteStatus() {
    if (!deleting) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/statuses/${deleting.row.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deleting.count > 0 ? { moveTo } : {}),
      });
      const data = await res.json().catch(() => ({}) as any);
      if (!res.ok) {
        alert(data.error ?? `Could not delete (HTTP ${res.status})`);
        return;
      }
      setDeleting(null);
      load();
    } finally {
      setBusy(false);
    }
  }

  function editor(
    title: string,
    hint: string,
    table: 'statuses' | 'stages',
    rows: any[],
    withClientFlag: boolean
  ) {
    const noun = table === 'statuses' ? 'status' : 'stage';
    // Names are UNIQUE in the schema; the raw Postgres message for that is
    // unreadable, and it is the most likely error an admin will ever hit here.
    const explain = (error: any) =>
      error?.code === '23505'
        ? `A ${noun} with that name already exists — names must be unique.`
        : error.message;

    const update = async (id: string, patch: Record<string, any>) => {
      const { data, error } = await supabase.from(table).update(patch).eq('id', id).select('id');
      if (error) {
        alert(explain(error));
      } else if (!data?.length) {
        // An RLS denial is SILENT: no error, zero rows. This is exactly how a
        // freshly added status "could not be given a name" — the edit just
        // vanished. Say it out loud instead.
        alert(`Not saved — your account does not have permission to edit ${table}.`);
      }
      load();
    };

    return (
      <div className="card">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-0.5 mb-3 text-xs text-gray-400">{hint}</p>
        <div className="space-y-1.5">
          {rows.map((row) => (
            <div key={row.id} className="flex items-center gap-2">
              <input
                type="color"
                className="h-7 w-9 cursor-pointer rounded border border-gray-200"
                value={row.color}
                onChange={(e) => update(row.id, { color: e.target.value })}
              />
              <input
                className="input min-w-0 flex-1"
                defaultValue={row.name}
                // Enter commits (via blur, the single save path). Without this
                // the only way to save a rename was to click elsewhere, with
                // no hint that anything was pending.
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                onBlur={(e) => {
                  const value = e.target.value.trim();
                  if (!value) {
                    e.target.value = row.name; // a nameless status helps no one
                    return;
                  }
                  if (value !== row.name) update(row.id, { name: value });
                }}
              />
              {/* basis-16 + shrink-0, not w-16: the .input primitive is unlayered,
                  so its w-full outranks Tailwind's width utilities (v4 keeps those
                  in @layer utilities, and unlayered CSS wins). flex-basis — which
                  .input never sets — sizes this box instead, and min-w-0 on the
                  name field beside it lets that field shrink and show its text. */}
              <input
                className="input shrink-0 basis-16"
                type="number"
                title="Sort order"
                defaultValue={row.sort_order}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                onBlur={(e) =>
                  Number(e.target.value) !== row.sort_order &&
                  update(row.id, { sort_order: Number(e.target.value) })
                }
              />
              {withClientFlag && (
                <label
                  className="flex items-center gap-1 text-xs text-gray-500"
                  title="Contacts with this status count as clients (countdown, notifications, files)"
                >
                  <input
                    type="checkbox"
                    checked={!!row.is_client_status}
                    onChange={(e) => update(row.id, { is_client_status: e.target.checked })}
                  />
                  client
                </label>
              )}
              <button
                className="text-xs text-gray-400 hover:text-red-600"
                title={`Delete this ${noun}`}
                onClick={async () => {
                  if (table === 'stages') {
                    if (!confirm(`Delete "${row.name}"? Clients in this stage keep working but lose it.`)) {
                      return;
                    }
                    const { data, error } = await supabase
                      .from(table)
                      .delete()
                      .eq('id', row.id)
                      .select('id');
                    if (error) alert(explain(error));
                    else if (!data?.length) alert('Not deleted — permission denied.');
                    load();
                    return;
                  }
                  // Statuses hold contacts, so deletion asks where they go.
                  const { count } = await supabase
                    .from('contacts')
                    .select('id', { count: 'exact', head: true })
                    .eq('status_id', row.id);
                  setMoveTo('');
                  setDeleting({ row, count: count ?? 0 });
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          className="btn mt-3 py-1"
          onClick={async () => {
            // Unique default name ("New status 2" when "New status" is taken):
            // names are unique in the schema, and the old silent duplicate
            // insert looked like an Add button that did nothing.
            const base = `New ${noun}`;
            const taken = new Set(rows.map((r) => String(r.name)));
            let name = base;
            for (let n = 2; taken.has(name); n += 1) name = `${base} ${n}`;
            const { error } = await supabase.from(table).insert({
              name,
              color: '#6366F1',
              sort_order: (rows[rows.length - 1]?.sort_order ?? 0) + 1,
            });
            if (error) alert(explain(error));
            load();
          }}
        >
          + Add
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-2xl font-light tracking-tight">Statuses & Stages</h1>
      {editor(
        'Lead statuses',
        'Colors show up across the whole CRM. "Client" statuses start the service countdown.',
        'statuses',
        statuses,
        true
      )}
      {editor(
        'Client stages',
        'The stages a client moves through after signing (editable on the Clients page).',
        'stages',
        stages,
        false
      )}

      {/* Delete a status: its contacts move somewhere the admin chose, never
          into limbo — the FK would otherwise silently null them out of every
          status filter. */}
      {deleting && (
        <div
          className="anim-fade-in fixed inset-0 z-40 flex items-center justify-center bg-black/20"
          onClick={() => setDeleting(null)}
        >
          <div
            className="anim-modal-in w-full max-w-sm rounded-xl bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-1 text-sm font-semibold">Delete “{deleting.row.name}”</h2>
            {deleting.count > 0 ? (
              <>
                <p className="mb-3 text-xs text-gray-500">
                  {deleting.count} contact{deleting.count === 1 ? '' : 's'} currently{' '}
                  {deleting.count === 1 ? 'uses' : 'use'} this status. Pick where they go — deleting
                  a stage of the pipeline should never strand its people.
                </p>
                <select
                  className="input mb-3"
                  value={moveTo}
                  onChange={(e) => setMoveTo(e.target.value)}
                >
                  <option value="">— move contacts to —</option>
                  {statuses
                    .filter((s) => s.id !== deleting.row.id)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </>
            ) : (
              <p className="mb-3 text-xs text-gray-500">No contacts use this status.</p>
            )}
            <div className="flex justify-end gap-2">
              <button className="btn" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                disabled={busy || (deleting.count > 0 && !moveTo)}
                onClick={deleteStatus}
              >
                {busy ? 'Deleting…' : deleting.count > 0 ? 'Move & delete' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
