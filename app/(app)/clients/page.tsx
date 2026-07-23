'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import ContactPanel from '@/components/ContactPanel';

/** Clients view: stages, service countdown, revenue projection, quick panel access. */
export default function ClientsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [clients, setClients] = useState<any[]>([]);
  const [stages, setStages] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: clientStatuses } = await supabase
      .from('statuses')
      .select('id')
      .eq('is_client_status', true);
    const ids = (clientStatuses ?? []).map((s) => s.id);

    let query = supabase
      .from('contacts')
      .select(
        'id, name, email, phone, stage_id, client_since, service_days, revenue_projection, reputation_score, stages ( id, name, color )'
      )
      .order('client_since', { ascending: true });
    // Anyone with a client status OR an active service period counts as a client.
    if (ids.length) query = query.or(`status_id.in.(${ids.join(',')}),client_since.not.is.null`);
    else query = query.not('client_since', 'is', null);

    const { data } = await query;
    setClients(data ?? []);
  }, [supabase]);

  useEffect(() => {
    load();
    supabase
      .from('stages')
      .select('*')
      .order('sort_order')
      .then(({ data }) => setStages(data ?? []));
  }, [load, supabase]);

  function daysLeft(c: any): number | null {
    if (!c.client_since) return null;
    const total = c.service_days ?? 90;
    return total - Math.floor((Date.now() - new Date(c.client_since).getTime()) / 86400000);
  }

  async function setStage(clientId: string, stageId: string) {
    setClients((rows) =>
      rows.map((r) =>
        r.id === clientId
          ? { ...r, stage_id: stageId, stages: stages.find((s) => s.id === stageId) ?? null }
          : r
      )
    );
    await fetch(`/api/contacts/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage_id: stageId || null }),
    });
  }

  const totalProjection = clients.reduce((s, c) => s + Number(c.revenue_projection ?? 0), 0);

  return (
    <div className="p-6">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Clients</h1>
        <div className="text-sm text-gray-500">
          {clients.length} client{clients.length === 1 ? '' : 's'} · projected{' '}
          <span className="font-mono font-semibold text-green-700">
            ${totalProjection.toLocaleString()}
          </span>
        </div>
      </div>

      <div className="card p-0">
        <table className="w-full">
          <thead>
            <tr>
              <th className="grid-th">Name</th>
              <th className="grid-th">Stage</th>
              <th className="grid-th">Countdown</th>
              <th className="grid-th">Rep Score</th>
              <th className="grid-th">Projected Revenue</th>
              <th className="grid-th">Email</th>
              <th className="grid-th">Phone</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => {
              const left = daysLeft(c);
              return (
                <tr key={c.id} className="grid-row" onClick={() => setSelectedId(c.id)}>
                  <td className="grid-td font-medium">{c.name}</td>
                  <td className="grid-td" onClick={(e) => e.stopPropagation()}>
                    <select
                      className="input w-44 py-1"
                      value={c.stage_id ?? ''}
                      style={{ color: c.stages?.color }}
                      onChange={(e) => setStage(c.id, e.target.value)}
                    >
                      <option value="">—</option>
                      {stages.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="grid-td">
                    {left != null && (
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                          left <= 0
                            ? 'bg-gray-100 text-gray-500'
                            : left <= 7
                              ? 'bg-red-100 text-red-700'
                              : left <= 30
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-green-100 text-green-700'
                        }`}
                      >
                        {left <= 0 ? 'Expired' : `${left} days`}
                      </span>
                    )}
                  </td>
                  <td className="grid-td font-mono">{c.reputation_score ?? ''}</td>
                  <td className="grid-td font-mono text-green-700">
                    {c.revenue_projection > 0 ? `$${Number(c.revenue_projection).toLocaleString()}` : ''}
                  </td>
                  <td className="grid-td text-gray-500">{c.email}</td>
                  <td className="grid-td text-gray-500">{c.phone}</td>
                </tr>
              );
            })}
            {clients.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-sm text-gray-400">
                  No clients yet — set a contact's status to a client status (e.g. "Client").
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selectedId && (
        <ContactPanel contactId={selectedId} onClose={() => setSelectedId(null)} onChanged={load} />
      )}
    </div>
  );
}
