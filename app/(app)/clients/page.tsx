'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import ContactPanel from '@/components/ContactPanel';
import { useMyRole } from '@/lib/use-my-role';

const PAGE_SIZE = 100;

/** Clients view: stages, service countdown, revenue projection, quick panel access. */
export default function ClientsPage() {
  const supabase = useMemo(() => createClient(), []);
  const { isAdmin } = useMyRole(); // revenue figures are admin-only
  const [clients, setClients] = useState<any[]>([]);
  const [stages, setStages] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [summary, setSummary] = useState({ count: 0, projection_total: 0 });
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    const { data: clientStatuses, error: statusesError } = await supabase
      .from('statuses')
      .select('id')
      .eq('is_client_status', true);
    if (statusesError) {
      setLoadError(statusesError.message);
      return;
    }
    const ids = (clientStatuses ?? []).map((s) => s.id);

    const cols =
      'id, name, name_source, email, phone, stage_id, client_since, service_days, reputation_score, stages ( id, name, color )';
    let query = supabase
      .from('contacts')
      .select(isAdmin ? `${cols}, revenue_projection` : cols)
      .order('client_since', { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    // Anyone with a client status OR an active service period counts as a client.
    if (ids.length) query = query.or(`status_id.in.(${ids.join(',')}),client_since.not.is.null`);
    else query = query.not('client_since', 'is', null);

    const [{ data, error }, { data: totals, error: totalsError }] = await Promise.all([
      query,
      supabase.rpc('client_summary'),
    ]);
    if (error || totalsError) {
      setLoadError(error?.message ?? totalsError?.message ?? 'Could not load clients');
      return;
    }
    setClients(data ?? []);
    if (totals) setSummary(totals as any);
  }, [supabase, isAdmin, page]);

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
    const response = await fetch(`/api/contacts/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage_id: stageId || null }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setLoadError(body.error ?? 'Could not update client stage');
      await load();
    }
  }

  const pageCount = Math.max(1, Math.ceil(summary.count / PAGE_SIZE));

  return (
    <div className="p-6">
      {loadError && (
        <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          {loadError}
        </div>
      )}
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-2xl font-light tracking-tight">Clients</h1>
        <div className="text-sm text-gray-500">
          {summary.count} client{summary.count === 1 ? '' : 's'}
          {isAdmin && (
            <>
              {' · projected '}
              <span className="font-mono font-semibold text-green-700">
                ${Number(summary.projection_total ?? 0).toLocaleString()}
              </span>
            </>
          )}
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
              {isAdmin && <th className="grid-th">Projected Revenue</th>}
              <th className="grid-th">Email</th>
              <th className="grid-th">Phone</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => {
              const left = daysLeft(c);
              return (
                <tr key={c.id} className="grid-row" onClick={() => setSelectedId(c.id)}>
                  <td className="grid-td font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      {c.name}
                      {c.name_source === 'reverse_lookup' && (
                        <span
                          className="text-[11px] leading-none"
                          title="Name from a reverse phone lookup — it may not be accurate"
                          aria-label="Name derived from a reverse phone lookup"
                        >
                          📞
                        </span>
                      )}
                    </span>
                  </td>
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
                  {isAdmin && (
                    <td className="grid-td font-mono text-green-700">
                      {c.revenue_projection > 0
                        ? `$${Number(c.revenue_projection).toLocaleString()}`
                        : ''}
                    </td>
                  )}
                  <td className="grid-td text-gray-500">{c.email}</td>
                  <td className="grid-td text-gray-500">{c.phone}</td>
                </tr>
              );
            })}
            {clients.length === 0 && (
              <tr>
                <td colSpan={isAdmin ? 7 : 6} className="px-4 py-12 text-center text-sm text-gray-400">
                  No clients yet — set a contact's status to a client status (e.g. "Client").
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-end gap-4 text-xs text-gray-500">
        <button className="btn py-1" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          Previous
        </button>
        <span>
          Page {page + 1} of {pageCount}
        </span>
        <button
          className="btn py-1"
          disabled={page >= pageCount - 1}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
      </div>

      {selectedId && (
        <ContactPanel
          contactId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={load}
          siblingIds={clients.map((c) => c.id)}
          onNavigate={setSelectedId}
        />
      )}
    </div>
  );
}
