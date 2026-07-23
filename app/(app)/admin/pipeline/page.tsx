'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

/** Admin: lead statuses (with colors) and client stages, both fully editable. */
export default function PipelinePage() {
  const supabase = useMemo(() => createClient(), []);
  const [statuses, setStatuses] = useState<any[]>([]);
  const [stages, setStages] = useState<any[]>([]);

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

  function editor(
    title: string,
    hint: string,
    table: 'statuses' | 'stages',
    rows: any[],
    withClientFlag: boolean
  ) {
    const update = async (id: string, patch: Record<string, any>) => {
      const { error } = await supabase.from(table).update(patch).eq('id', id);
      if (error) alert(error.message);
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
                className="input flex-1"
                defaultValue={row.name}
                onBlur={(e) => e.target.value !== row.name && update(row.id, { name: e.target.value })}
              />
              <input
                className="input w-16"
                type="number"
                title="Sort order"
                defaultValue={row.sort_order}
                onBlur={(e) => update(row.id, { sort_order: Number(e.target.value) })}
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
                onClick={async () => {
                  if (!confirm(`Delete "${row.name}"? Contacts using it keep working but lose it.`))
                    return;
                  await supabase.from(table).delete().eq('id', row.id);
                  load();
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
            await supabase.from(table).insert({
              name: `New ${table === 'statuses' ? 'status' : 'stage'}`,
              color: '#6366F1',
              sort_order: (rows[rows.length - 1]?.sort_order ?? 0) + 1,
            });
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
      <h1 className="text-lg font-semibold">Statuses & Stages</h1>
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
    </div>
  );
}
