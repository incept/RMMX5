'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import ContactPanel from '@/components/ContactPanel';
import { NameSourceIcon } from '@/components/NameSourceIcon';
import { useMyRole } from '@/lib/use-my-role';
import { useAutoRefresh } from '@/lib/use-auto-refresh';
import { useRealtimeRefresh } from '@/lib/use-realtime-refresh';

const PAGE_SIZE = 100;
// Reorderable client columns persisted here. Name is pinned first, so only the
// optional columns are stored.
const COLS_LS = 'rmmx5-client-columns-v1';

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

type ClientColKey =
  | 'state'
  | 'stage'
  | 'signed'
  | 'countdown'
  | 'linkstats'
  | 'gross'
  | 'source'
  | 'email'
  | 'phone';

const DEFAULT_CLIENT_ORDER: ClientColKey[] = [
  'state', 'stage', 'signed', 'countdown', 'linkstats', 'gross', 'source', 'email', 'phone',
];

// Text columns read better ascending; scores/dates with the soonest/biggest
// first — matching the contacts grid's defaults.
const ASC_FIRST = new Set(['name', 'state', 'source', 'email', 'phone']);

interface ClientColumn {
  label: string;
  /** DB column the server sorts on; omit for non-sortable (interactive/derived). */
  sortKey?: string;
  adminOnly?: boolean;
  /** Interactive cells (a dropdown) must not open the panel on click. */
  stopClick?: boolean;
  cellClass?: string;
  headerTitle?: string;
  render: (c: any) => ReactNode;
}

/** Clients view: reorderable, sortable columns; search; stages, countdown, link mix. */
export default function ClientsPage() {
  const supabase = useMemo(() => createClient(), []);
  const { isAdmin } = useMyRole(); // revenue figures are admin-only
  const [clients, setClients] = useState<any[]>([]);
  const [stages, setStages] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [summary, setSummary] = useState({ count: 0, projection_total: 0 });
  const [loadError, setLoadError] = useState('');
  const [order, setOrder] = useState<ClientColKey[]>(DEFAULT_CLIENT_ORDER);
  const [sort, setSort] = useState('client_since');
  const [asc, setAsc] = useState(true);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const dragCol = useRef<ClientColKey | null>(null);
  const [dragOver, setDragOver] = useState<ClientColKey | null>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const params = new URLSearchParams({ page: String(page), sort, dir: asc ? 'asc' : 'desc' });
      if (debouncedSearch.trim()) params.set('q', debouncedSearch.trim());
      const response = await fetch(`/api/clients?${params}`, { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Could not load clients');
      setClients(body.clients ?? []);
      if (body.summary) setSummary(body.summary);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load clients');
    }
  }, [page, sort, asc, debouncedSearch]);

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

  // A sort or search change starts over at the first page.
  useEffect(() => setPage(0), [sort, asc, debouncedSearch]);

  // Debounce the search box so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Restore the saved column order, appending any column added since it was saved.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLS_LS);
      if (!raw) return;
      const saved = JSON.parse(raw);
      const kept = (saved.order ?? []).filter((k: any) => DEFAULT_CLIENT_ORDER.includes(k));
      setOrder([...kept, ...DEFAULT_CLIENT_ORDER.filter((k) => !kept.includes(k))]);
    } catch {
      /* corrupted prefs — defaults are fine */
    }
  }, []);

  function persistOrder(next: ClientColKey[]) {
    try {
      localStorage.setItem(COLS_LS, JSON.stringify({ order: next }));
    } catch {
      /* private mode / quota — ordering still works this session */
    }
  }

  function moveCol(from: ClientColKey, to: ClientColKey) {
    if (from === to) return;
    setOrder((prev) => {
      const next = prev.filter((k) => k !== from);
      const at = next.indexOf(to);
      next.splice(at < 0 ? next.length : at, 0, from);
      persistOrder(next);
      return next;
    });
  }

  function toggleSort(key: string) {
    if (sort === key) setAsc((v) => !v);
    else {
      setSort(key);
      setAsc(ASC_FIRST.has(key));
    }
  }

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

  const columns: Record<ClientColKey, ClientColumn> = {
    state: { label: 'State', sortKey: 'state', cellClass: 'text-gray-500', render: (c) => c.state ?? '' },
    stage: {
      label: 'Stage',
      stopClick: true,
      render: (c) => (
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
      ),
    },
    signed: { label: 'Signed', sortKey: 'signed_date', cellClass: 'text-gray-500', render: (c) => c.signed_date ?? '' },
    countdown: {
      label: 'Countdown',
      sortKey: 'client_since',
      render: (c) => {
        const left = daysLeft(c);
        if (left == null) return '';
        return (
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
        );
      },
    },
    linkstats: {
      label: 'Link Stats',
      headerTitle: 'Removal links — Live / Requested / Removed. Drag to reorder.',
      render: (c) => <LinkStats links={c.contact_links} />,
    },
    gross: {
      label: 'Gross',
      sortKey: 'gross_revenue',
      adminOnly: true,
      cellClass: 'font-mono text-green-700',
      render: (c) => (c.gross_revenue > 0 ? `$${Number(c.gross_revenue).toLocaleString()}` : ''),
    },
    source: { label: 'Source', sortKey: 'source', cellClass: 'text-gray-500', render: (c) => c.source ?? '' },
    email: { label: 'Email', sortKey: 'email', cellClass: 'text-gray-500', render: (c) => c.email },
    phone: { label: 'Phone', sortKey: 'phone', cellClass: 'text-gray-500', render: (c) => c.phone },
  };

  const visibleCols = order.filter((key) => isAdmin || !columns[key].adminOnly);
  const pageCount = Math.max(1, Math.ceil(summary.count / PAGE_SIZE));
  const sortArrow = (key: string) =>
    sort === key ? <span className="text-gray-900">{asc ? '↑' : '↓'}</span> : null;

  return (
    <div className="p-6">
      {loadError && (
        <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{loadError}</div>
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

      <div className="mb-3">
        <input
          className="input max-w-xs"
          type="search"
          placeholder="Search name, email, or phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full">
          <thead>
            <tr>
              <th
                className="grid-th cursor-pointer hover:text-gray-700"
                title="Click to sort"
                onClick={() => toggleSort('name')}
              >
                <span className="inline-flex items-center gap-1">Name {sortArrow('name')}</span>
              </th>
              {visibleCols.map((key) => {
                const col = columns[key];
                return (
                  <th
                    key={key}
                    draggable
                    onDragStart={(e) => {
                      dragCol.current = key;
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={(e) => {
                      if (!dragCol.current) return;
                      e.preventDefault();
                      if (dragOver !== key) setDragOver(key);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = dragCol.current;
                      dragCol.current = null;
                      setDragOver(null);
                      if (from) moveCol(from, key);
                    }}
                    onDragEnd={() => {
                      dragCol.current = null;
                      setDragOver(null);
                    }}
                    title={
                      col.headerTitle ??
                      (col.sortKey ? 'Click to sort · drag to reorder' : 'Drag to reorder')
                    }
                    className={`grid-th cursor-grab hover:text-gray-700 active:cursor-grabbing ${
                      dragOver === key ? 'border-l-2 border-brand-500 text-gray-900' : ''
                    }`}
                    onClick={() => col.sortKey && toggleSort(col.sortKey)}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.label} {col.sortKey && sortArrow(col.sortKey)}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id} className="grid-row" onClick={() => setSelectedId(c.id)}>
                <td className="grid-td font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    {c.name}
                    <NameSourceIcon source={c.name_source} className="h-3 w-3" />
                  </span>
                </td>
                {visibleCols.map((key) => {
                  const col = columns[key];
                  return (
                    <td
                      key={key}
                      className={`grid-td ${col.cellClass ?? ''}`}
                      onClick={col.stopClick ? (e) => e.stopPropagation() : undefined}
                    >
                      {col.render(c)}
                    </td>
                  );
                })}
              </tr>
            ))}
            {clients.length === 0 && (
              <tr>
                <td
                  colSpan={visibleCols.length + 1}
                  className="px-4 py-12 text-center text-sm text-gray-400"
                >
                  No clients yet — set a contact&apos;s status to a client status (e.g. &quot;Client&quot;).
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
