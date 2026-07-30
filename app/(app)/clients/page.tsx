'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import ContactPanel from '@/components/ContactPanel';
import { NameSourceIcon } from '@/components/NameSourceIcon';
import { useMyRole } from '@/lib/use-my-role';
import { useAutoRefresh } from '@/lib/use-auto-refresh';
import { useRealtimeRefresh } from '@/lib/use-realtime-refresh';

const PAGE_SIZE = 100;

// Removal links by status, each count in the status's colour so admins read the
// removal mix at a glance: Live red, Requested orange, Removed green.
const LINK_STATS = [
  { key: 'live', color: '#EF4444', label: 'Live' },
  { key: 'requested', color: '#F59E0B', label: 'Requested' },
  { key: 'removed', color: '#22C55E', label: 'Removed' },
] as const;

function LinkStats({ links }: { links?: { status: string }[] | null }) {
  if (!links || links.length === 0) return <span className="text-gray-300">—</span>;
  const counts: Record<string, number> = { live: 0, requested: 0, removed: 0 };
  for (const l of links) if (l.status in counts) counts[l.status] += 1;
  return (
    <span className="inline-flex items-center gap-2 font-mono text-sm font-semibold tabular-nums">
      {LINK_STATS.map(({ key, color, label }) => (
        <span key={key} style={{ color }} title={`${counts[key]} ${label}`}>
          {counts[key]}
        </span>
      ))}
    </span>
  );
}

/** Clients view: stages, service countdown, link-status mix, quick panel access. */
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
    try {
      const response = await fetch(`/api/clients?page=${page}`, { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Could not load clients');
      setClients(body.clients ?? []);
      if (body.summary) setSummary(body.summary);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load clients');
    }
  }, [page]);

  useAutoRefresh(load);
  useRealtimeRefresh('contacts', load);

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
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-light tracking-tight">Clients</h1>
          {isAdmin && (
            <Link href="/import/clients" className="btn py-1 text-xs">
              Import roster
            </Link>
          )}
        </div>
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
              <th className="grid-th">State</th>
              <th className="grid-th">Stage</th>
              <th className="grid-th">Signed</th>
              <th className="grid-th">Countdown</th>
              <th className="grid-th" title="Removal links — Live / Requested / Removed">
                Link Stats
              </th>
              {isAdmin && <th className="grid-th">Gross</th>}
              <th className="grid-th">Source</th>
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
                      <NameSourceIcon source={c.name_source} className="h-3 w-3" />
                    </span>
                  </td>
                  <td className="grid-td text-gray-500">{c.state ?? ''}</td>
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
                  <td className="grid-td text-gray-500">{c.signed_date ?? ''}</td>
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
                  <td className="grid-td">
                    <LinkStats links={c.contact_links} />
                  </td>
                  {isAdmin && (
                    <td className="grid-td font-mono text-green-700">
                      {c.gross_revenue > 0 ? `$${Number(c.gross_revenue).toLocaleString()}` : ''}
                    </td>
                  )}
                  <td className="grid-td text-gray-500">{c.source ?? ''}</td>
                  <td className="grid-td text-gray-500">{c.email}</td>
                  <td className="grid-td text-gray-500">{c.phone}</td>
                </tr>
              );
            })}
            {clients.length === 0 && (
              <tr>
                <td colSpan={isAdmin ? 10 : 9} className="px-4 py-12 text-center text-sm text-gray-400">
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
