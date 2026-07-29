'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import StatusPill, { type StatusOption } from '@/components/StatusPill';
import ContactPanel from '@/components/ContactPanel';
import { useMyRole } from '@/lib/use-my-role';

interface ContactRow {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  email: string | null;
  phone: string | null;
  status_id: string | null;
  owner_id: string | null;
  reputation_score: number | null;
  link_score: number | null;
  search_flag: string | null;
  deep_searched_at: string | null;
  deep_search_queued_at: string | null;
  created_at: string;
  statuses: (StatusOption & { is_client_status?: boolean }) | null;
  contact_links: { id: string; url: string; status: string }[];
  // Merged in from the contact_email_stats view.
  email_sent: number;
  email_opens: number;
  email_clicks: number;
}

interface Profile {
  id: string;
  full_name: string | null;
  email: string | null;
}

type SortKey =
  | 'name'
  | 'created_at'
  | 'reputation_score'
  | 'link_score'
  | 'status'
  | 'email_sent'
  | 'email_opens'
  | 'email_clicks';
type ViewId = 'all' | 'mine' | 'clients' | 'flagged' | 'recent';
// 'mine' stays in the type (the counts RPC still returns it) but has no chip:
// contacts aren't assigned to owners at this time. The flag view is icon-only
// and 'recent' is just "New" — the count beside each label carries the detail.
const VIEW_DEFS: { id: ViewId; label: string; title?: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'clients', label: 'Clients' },
  { id: 'flagged', label: '⚑', title: 'Flagged — the search wants a re-run' },
  { id: 'recent', label: 'New', title: 'Created in the last 7 days' },
];

interface NewContactDraft {
  name: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  county: string;
  status_id: string;
}

/** Every optional column, in factory order. Name is pinned and not listed. */
type ColKey =
  | 'email'
  | 'phone'
  | 'location'
  | 'status'
  | 'rep'
  | 'link'
  | 'links'
  | 'sent'
  | 'opens'
  | 'clicks'
  | 'owner'
  | 'created';

const DEFAULT_ORDER: ColKey[] = [
  'email', 'phone', 'location', 'status', 'rep', 'link', 'links',
  'sent', 'opens', 'clicks', 'owner', 'created',
];
// Location is off by default because the Contact column already shows city and
// state beside the name; turn it on for a sortable, reorderable column of its own.
const DEFAULT_HIDDEN: ColKey[] = ['owner', 'location'];

const PAGE_SIZE = 50;
const DEEP_SEARCH_POLL_INTERVAL_MS = 30_000;
const DEEP_SEARCH_POLL_WINDOW_MS = 20 * 60_000;
// v2: the shape changed from a visibility map to { order, hidden } when columns
// became reorderable. A fresh key means old prefs are ignored, not misread.
const COLS_LS = 'rmmx5-contact-columns-v2';

const SORT_LABELS: Record<SortKey, string> = {
  name: 'name',
  created_at: 'created',
  reputation_score: 'rep score',
  link_score: 'link score',
  status: 'status',
  email_sent: 'emails sent',
  email_opens: 'opens',
  email_clicks: 'clicks',
};

/**
 * The main CRM view, relaid out after the iCRM design study: saved views with
 * counts, status dot-filters, inline email editing, bulk actions on a floating
 * bar, and a slide-over detail panel — all on the app's existing light/dark
 * token palette.
 *
 * Columns are user-owned: drag any header to reorder, toggle visibility from
 * the Columns menu, and both stick in localStorage until changed again.
 */
export default function ContactsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [total, setTotal] = useState(0);
  const [viewCounts, setViewCounts] = useState<Record<ViewId, number>>({
    all: 0,
    mine: 0,
    clients: 0,
    flagged: 0,
    recent: 0,
  });
  const [statuses, setStatuses] = useState<(StatusOption & { is_client_status?: boolean })[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ViewId>('all');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [sortAsc, setSortAsc] = useState(false);
  const [order, setOrder] = useState<ColKey[]>(DEFAULT_ORDER);
  const [hidden, setHidden] = useState<Set<ColKey>>(new Set(DEFAULT_HIDDEN));
  const [colMenu, setColMenu] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [editEmailId, setEditEmailId] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState('');
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [newContact, setNewContact] = useState<NewContactDraft | null>(null);
  const [creating, setCreating] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const deepSearchWatches = useRef<
    Map<string, { contact: ContactRow; expiresAt: number; refreshFailures: number }>
  >(new Map());
  const deepSearchPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deepSearchPollInFlight = useRef(false);
  const { isAdmin } = useMyRole();

  useEffect(
    () => () => {
      deepSearchWatches.current.clear();
      if (deepSearchPollTimer.current) clearTimeout(deepSearchPollTimer.current);
      deepSearchPollTimer.current = null;
    },
    []
  );

  /* ── column prefs ── */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLS_LS);
      if (!raw) return;
      const saved = JSON.parse(raw);
      const kept = (saved.order ?? []).filter((k: any) => DEFAULT_ORDER.includes(k));
      // Append any column added to the app since these prefs were written, so
      // a new column is never stranded outside the user's saved order.
      setOrder([...kept, ...DEFAULT_ORDER.filter((k) => !kept.includes(k))]);
      setHidden(new Set((saved.hidden ?? []).filter((k: any) => DEFAULT_ORDER.includes(k))));
    } catch {
      /* corrupted prefs — defaults are fine */
    }
  }, []);

  function persistCols(nextOrder: ColKey[], nextHidden: Set<ColKey>) {
    try {
      localStorage.setItem(
        COLS_LS,
        JSON.stringify({ order: nextOrder, hidden: [...nextHidden] })
      );
    } catch {
      /* private mode / quota — ordering still works for this session */
    }
  }

  function toggleCol(key: ColKey) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      persistCols(order, next);
      return next;
    });
  }

  /** Moves `from` to sit where `to` currently is, within the full order. */
  function moveCol(from: ColKey, to: ColKey) {
    if (from === to) return;
    setOrder((prev) => {
      const next = prev.filter((k) => k !== from);
      const at = next.indexOf(to);
      next.splice(at < 0 ? next.length : at, 0, from);
      persistCols(next, hidden);
      return next;
    });
  }

  /** Keyboard-accessible nudge for the Columns menu (drag needs a mouse). */
  function nudgeCol(key: ColKey, delta: -1 | 1) {
    setOrder((prev) => {
      const i = prev.indexOf(key);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      persistCols(next, hidden);
      return next;
    });
  }

  const dragCol = useRef<ColKey | null>(null);
  const [dragOverCol, setDragOverCol] = useState<ColKey | null>(null);

  function flash(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2400);
  }

  /* ── data ── */
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [pageResult, countsResult] = await Promise.all([
        supabase.rpc('contacts_grid_page', {
          p_search: search.trim(),
          p_view: view,
          p_status: statusFilter || null,
          p_sort: sortKey,
          p_ascending: sortAsc,
          p_page: page,
          p_page_size: PAGE_SIZE,
        }),
        supabase.rpc('contact_view_counts'),
      ]);
      const errors: string[] = [];
      if (!pageResult.error) {
        const payload = (pageResult.data ?? {}) as any;
        setContacts(payload.rows ?? []);
        setTotal(Number(payload.total) || 0);
      } else {
        errors.push(pageResult.error.message);
      }
      if (!countsResult.error && countsResult.data) {
        setViewCounts(countsResult.data as Record<ViewId, number>);
      } else if (countsResult.error) {
        errors.push(`Could not refresh view counts: ${countsResult.error.message}`);
      }
      setLoadError(errors.join(' · '));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Network request failed');
    } finally {
      setLoading(false);
    }
  }, [supabase, search, view, statusFilter, sortKey, sortAsc, page]);

  useEffect(() => {
    const t = setTimeout(load, search ? 250 : 0); // debounce typing
    return () => clearTimeout(t);
  }, [load, search]);

  useEffect(() => {
    supabase
      .from('statuses')
      .select('id, name, color, is_client_status')
      .order('sort_order')
      .then(({ data }) => setStatuses(data ?? []));
    supabase
      .from('profiles')
      .select('id, full_name, email')
      .order('full_name')
      .then(({ data }) => setProfiles(data ?? []));
  }, [supabase]);

  const ownerName = useCallback(
    (id: string | null) => {
      if (!id) return '';
      const p = profiles.find((x) => x.id === id);
      return p?.full_name || p?.email || '';
    },
    [profiles]
  );

  /* ── views / filters / sort / pages ── */
  const sorted = contacts;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = sorted;
  useEffect(() => setPage(0), [view, statusFilter, search, sortKey, sortAsc]);

  const filtersDirty = view !== 'all' || statusFilter !== '' || !!search.trim();
  function clearFilters() {
    setView('all');
    setStatusFilter('');
    setSearch('');
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(key === 'name');
    }
  }

  /* ── selection + bulk actions ── */
  const visibleIds = pageRows.map((c) => c.id);
  const allOn = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  function toggleAll() {
    setSelected(allOn ? new Set() : new Set(visibleIds));
  }
  function toggleOne(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** PATCH one field on every selected contact via the existing per-id API
   *  (which keeps status side effects: sequences, notifications, activity). */
  async function bulkPatch(patch: Record<string, any>, doneMsg: string) {
    if (bulkBusy) return;
    setBulkBusy(true);
    const ids = [...selected];
    let ok = 0;
    for (const id of ids) {
      const res = await fetch(`/api/contacts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.ok) ok += 1;
    }
    setBulkBusy(false);
    setSelected(new Set());
    flash(ok === ids.length ? doneMsg : `${doneMsg} (${ok}/${ids.length} succeeded)`);
    await load();
  }

  /**
   * Deletes every selected contact. Irreversible and cascading (links,
   * activity, files, calls go with the row), so it asks first and spells out
   * the count. Admin-only — the API rejects non-admins anyway, so the button
   * is hidden rather than left to fail.
   */
  async function bulkDelete() {
    if (bulkBusy) return;
    const ids = [...selected];
    const label = `${ids.length} contact${ids.length === 1 ? '' : 's'}`;
    if (
      !confirm(
        `Delete ${label}?\n\nThis cannot be undone. Their links, activity, files, and call records are deleted too.`
      )
    ) {
      return;
    }
    setBulkBusy(true);
    let ok = 0;
    for (const id of ids) {
      const res = await fetch(`/api/contacts/${id}`, { method: 'DELETE' });
      if (res.ok) ok += 1;
    }
    setBulkBusy(false);
    setSelected(new Set());
    if (selectedId && ids.includes(selectedId)) setSelectedId(null); // panel would 404
    flash(
      ok === ids.length
        ? `Deleted ${label}`
        : `Deleted ${ok} of ${ids.length} — the rest failed (admins only)`
    );
    await load();
  }

  /* ── inline email edit ── */
  function startEmailEdit(c: ContactRow) {
    setEditEmailId(c.id);
    setEmailDraft(c.email ?? '');
  }
  async function commitEmailEdit(c: ContactRow) {
    const value = emailDraft.trim();
    setEditEmailId(null);
    if (value === (c.email ?? '')) return;
    setContacts((rows) => rows.map((r) => (r.id === c.id ? { ...r, email: value || null } : r)));
    const res = await fetch(`/api/contacts/${c.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: value || null }),
    });
    if (res.ok) flash('Email updated');
    else {
      flash('Email update failed');
      await load();
    }
  }

  async function setStatus(contactId: string, statusId: string) {
    // optimistic
    setContacts((rows) =>
      rows.map((r) =>
        r.id === contactId
          ? { ...r, status_id: statusId, statuses: statuses.find((s) => s.id === statusId) ?? null }
          : r
      )
    );
    await fetch(`/api/contacts/${contactId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status_id: statusId }),
    });
  }

  /* ── new contact modal ── */
  function openNewContact() {
    setNewContact({
      name: '', email: '', phone: '', city: '', state: '', county: '',
      status_id: statuses.find((s) => s.name === 'New')?.id ?? '',
    });
  }
  async function saveNewContact() {
    if (!newContact) return;
    if (!newContact.name.trim() && !newContact.email.trim()) {
      alert('Enter at least a name or an email address.');
      return;
    }
    setCreating(true);
    // A county typed here is human knowledge, not a guess, so it goes straight
    // into confirmed_facts — the store that seeds every deep search and
    // outranks whatever a search finds. Contacts has no county column.
    const county = newContact.county.trim();
    const { data, error } = await supabase
      .from('contacts')
      .insert({
        name: newContact.name.trim() || newContact.email.trim(),
        email: newContact.email.trim() || null,
        phone: newContact.phone.trim() || null,
        city: newContact.city.trim() || null,
        state: newContact.state.trim() || null,
        status_id: newContact.status_id || null,
        source: 'manual',
        ...(county ? { confirmed_facts: { county: [county] } } : {}),
      })
      .select('id')
      .single();
    setCreating(false);
    if (error) {
      alert(error.message);
      return;
    }
    setNewContact(null);
    await load();
    if (data) setSelectedId(data.id);
  }

  /* ── column definitions ─────────────────────────────────────────────────
     One entry per optional column: the same `width` drives the header and the
     cell so they can't drift apart, and `render` keeps each cell's markup with
     its heading. */
  const COLUMNS: Record<
    ColKey,
    {
      label: string;
      width: string;
      sortKey?: SortKey;
      align?: string;
      render: (c: ContactRow) => React.ReactNode;
    }
  > = {
    email: {
      label: 'Email',
      width: 'w-52',
      render: (contact) =>
        editEmailId === contact.id ? (
          <input
            autoFocus
            className="h-6 w-44 rounded-md border border-gray-300 bg-white px-2 text-xs outline-none focus:border-brand-500"
            value={emailDraft}
            onChange={(e) => setEmailDraft(e.target.value)}
            onBlur={() => commitEmailEdit(contact)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEmailEdit(contact);
              if (e.key === 'Escape') setEditEmailId(null);
            }}
          />
        ) : (
          <span
            className="block cursor-text truncate text-xs font-light text-gray-500 hover:text-gray-900"
            title="Click to edit"
            onClick={(e) => {
              e.stopPropagation();
              startEmailEdit(contact);
            }}
          >
            {contact.email || <span className="text-gray-300">—</span>}
          </span>
        ),
    },
    phone: {
      label: 'Phone',
      width: 'w-32',
      render: (c) => <span className="truncate text-xs font-light text-gray-500">{c.phone}</span>,
    },
    location: {
      label: 'Location',
      width: 'w-36',
      render: (c) => (
        <span className="truncate text-xs font-light text-gray-500">
          {[c.city, c.state].filter(Boolean).join(', ')}
        </span>
      ),
    },
    status: {
      label: 'Status',
      width: 'w-36',
      sortKey: 'status',
      render: (c) => (
        <div onClick={(e) => e.stopPropagation()}>
          <StatusPill
            status={c.statuses}
            options={statuses}
            onChange={(statusId) => setStatus(c.id, statusId)}
          />
        </div>
      ),
    },
    rep: {
      label: 'Rep',
      width: 'w-20',
      sortKey: 'reputation_score',
      render: (c) =>
        c.reputation_score == null ? null : (
          <span
            className={`text-xs font-medium tabular-nums ${
              Number(c.reputation_score) >= 70
                ? 'text-green-600'
                : Number(c.reputation_score) >= 40
                  ? 'text-amber-600'
                  : 'text-red-600'
            }`}
          >
            {c.reputation_score}
          </span>
        ),
    },
    link: {
      label: 'Links',
      width: 'w-20',
      sortKey: 'link_score',
      render: (c) => <span className="text-xs tabular-nums text-gray-500">{c.link_score}</span>,
    },
    links: {
      label: 'Live',
      width: 'w-16',
      render: (c) => {
        const live = c.contact_links.filter((l) => l.url && l.status === 'live').length;
        return <span className="text-xs tabular-nums text-gray-500">{live || ''}</span>;
      },
    },
    sent: {
      label: 'Sent',
      width: 'w-16',
      sortKey: 'email_sent',
      render: (c) => (
        <span className="text-xs tabular-nums text-gray-500">{c.email_sent || ''}</span>
      ),
    },
    opens: {
      label: 'Opens',
      width: 'w-16',
      sortKey: 'email_opens',
      render: (c) …3513 tokens truncated…     ))}
                  <div className="mt-1 border-t border-gray-100 px-2 pt-1.5 text-[10px] leading-snug text-gray-400">
                    Drag a column heading in the grid to reorder, or use ↑ ↓ here.
                  </div>
                </div>
              </>
            )}
          </div>
          <Link
            href="/import"
            className="h-8 rounded-full px-3 text-xs leading-8 text-gray-500 hover:text-gray-900"
          >
            Import
          </Link>
          <button
            className="h-8 rounded-full bg-green-600/15 px-4 text-xs font-medium text-green-700 transition hover:bg-green-600/25 active:scale-95"
            onClick={openNewContact}
            title="New contact"
          >
            New
          </button>
        </div>
      </div>

      {/* ── Views + status dot filters ── */}
      {loadError && (
        <div className="mx-6 mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          Could not load contacts: {loadError}
        </div>
      )}

      <div className="flex flex-none flex-wrap items-center gap-4 px-6 pb-3 pt-3.5">
        <div className="flex flex-wrap items-center gap-4">
          {VIEW_DEFS.map((v) => (
            <button
              key={v.id}
              title={v.title}
              className={`inline-flex items-baseline gap-1.5 whitespace-nowrap text-xs transition ${
                view === v.id ? 'font-semibold text-gray-900' : 'text-gray-400 hover:text-gray-900'
              }`}
              onClick={() => {
                setView(v.id);
                setSelected(new Set());
              }}
            >
              <span>{v.label}</span>
              <span className="text-[10px] font-normal tabular-nums text-gray-400">
                {viewCounts[v.id] ?? 0}
              </span>
            </button>
          ))}
        </div>
        <span className="h-3.5 w-px bg-gray-200" />
        {/*
          A dropdown rather than a chip per status. Sixteen statuses wrapped onto
          two or three lines and pushed the grid itself below the fold, which cost
          more than the one click a select adds. The colour dot is kept beside it
          because status colour is the same cue used on the rows and in the panel,
          and a bare name would break that association. The pill wrapper is the
          same treatment as the search input, and the gray ramp flips with the
          theme, so it reads as one of the app's controls in both modes.
        */}
        <div className="flex h-7 flex-none items-center gap-1.5 rounded-full bg-gray-100 pl-3 pr-1.5">
          <span
            className="h-[5px] w-[5px] flex-none rounded-full"
            style={{
              background:
                statuses.find((s) => s.id === statusFilter)?.color || '#d1d5db',
            }}
          />
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setSelected(new Set());
            }}
            aria-label="Filter by status"
            className={`max-w-[170px] cursor-pointer truncate border-none bg-transparent py-0 pr-5 pl-0 text-xs focus:ring-0 ${
              statusFilter === '' ? 'text-gray-400' : 'font-medium text-gray-900'
            }`}
          >
            <option value="">Any</option>
            {statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        {filtersDirty && (
          <button
            className="text-[11px] text-gray-500 underline underline-offset-2 hover:text-gray-900"
            onClick={clearFilters}
          >
            Reset
          </button>
        )}
        <div className="flex-1" />
        <span className="text-[11px] text-gray-400">
          Sorted by {SORT_LABELS[sortKey]} {sortAsc ? '↑' : '↓'}
        </span>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col border-t border-gray-200">
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="min-w-[1080px]">
            {/* header — each optional heading is a drag handle */}
            <div className="sticky top-0 z-10 flex h-8 items-center border-b border-gray-200 bg-canvas px-6 text-[10px] font-medium uppercase tracking-widest text-gray-400">
              <div className="w-8 flex-none">
                {checkbox(allOn, () => toggleAll())}
              </div>
              <div
                className="flex min-w-[220px] flex-1 cursor-pointer items-center gap-1.5 hover:text-gray-700"
                onClick={() => toggleSort('name')}
              >
                Contact
                {sortKey === 'name' && <span className="text-gray-900">{sortAsc ? '↑' : '↓'}</span>}
              </div>
              {visibleCols.map((key) => {
                const col = COLUMNS[key];
                return (
                  <div
                    key={key}
                    draggable
                    onDragStart={(e) => {
                      dragCol.current = key;
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={(e) => {
                      if (!dragCol.current) return;
                      e.preventDefault();
                      if (dragOverCol !== key) setDragOverCol(key);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = dragCol.current;
                      dragCol.current = null;
                      setDragOverCol(null);
                      if (from) moveCol(from, key);
                    }}
                    onDragEnd={() => {
                      dragCol.current = null;
                      setDragOverCol(null);
                    }}
                    title={
                      col.sortKey ? 'Click to sort · drag to reorder' : 'Drag to reorder'
                    }
                    className={`${col.width} flex flex-none cursor-grab items-center gap-1.5 active:cursor-grabbing ${
                      col.sortKey ? 'hover:text-gray-700' : ''
                    } ${dragOverCol === key ? 'border-l-2 border-brand-500 text-gray-900' : ''}`}
                    onClick={() => col.sortKey && toggleSort(col.sortKey)}
                  >
                    {col.label}
                    {col.sortKey && sortKey === col.sortKey && (
                      <span className="text-gray-900">{sortAsc ? '↑' : '↓'}</span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* rows */}
            {!loading &&
              pageRows.map((contact, i) => {
                const isSel = selected.has(contact.id);
                return (
                  <div
                    key={contact.id}
                    className={`anim-row-in flex h-[34px] items-center border-b border-gray-100 px-6 transition-colors hover:bg-gray-50 ${
                      isSel ? 'bg-gray-50' : ''
                    }`}
                    style={{ animationDelay: `${Math.min(i * 20, 320)}ms` }}
                  >
                    <div className="w-8 flex-none">
                      {checkbox(isSel, (e) => {
                        e.stopPropagation();
                        toggleOne(contact.id);
                      })}
                    </div>
                    <div
                      className="flex min-w-[220px] flex-1 cursor-pointer items-baseline gap-2 pr-3"
                      onClick={() => setSelectedId(contact.id)}
                    >
                      {searchIcon(contact)}
                      {contact.search_flag && (
                        <span
                          className="cursor-help text-amber-500"
                          title={`Search needs a re-run: ${contact.search_flag}`}
                        >
                          ⚑
                        </span>
                      )}
                      <span className="whitespace-nowrap text-xs font-medium">{contact.name}</span>
                      <span className="truncate text-[11px] font-light text-gray-400">
                        {[contact.city, contact.state].filter(Boolean).join(', ')}
                      </span>
                    </div>
                    {visibleCols.map((key) => (
                      <div key={key} className={`${COLUMNS[key].width} flex-none pr-3`}>
                        {COLUMNS[key].render(contact)}
                      </div>
                    ))}
                  </div>
                );
              })}

            {/* skeletons */}
            {loading &&
              skeletonWidths.map((w, i) => (
                <div
                  key={i}
                  className="flex h-[34px] items-center gap-4 border-b border-gray-100 px-6"
                >
                  <span className="anim-shimmer h-[13px] w-[13px] flex-none rounded bg-gray-200" />
                  <span className="anim-shimmer h-2 rounded bg-gray-200" style={{ width: w }} />
                  <span className="anim-shimmer h-2 w-36 rounded bg-gray-100" />
                  <span className="anim-shimmer h-2 w-20 rounded bg-gray-100" />
                  <span className="anim-shimmer h-2 w-28 rounded bg-gray-100" />
                </div>
              ))}
          </div>

          {/* empty / no-results */}
          {!loading && sorted.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2.5 px-6 py-16 text-center">
              {contacts.length === 0 && !filtersDirty ? (
                <>
                  <span className="text-sm">No contacts yet</span>
                  <span className="max-w-xs text-xs font-light text-gray-400">
                    Import a CSV from your old CRM, or add the first contact by hand.
                  </span>
                  <div className="mt-1 flex gap-2">
                    <Link href="/import" className="btn">
                      Import CSV
                    </Link>
                    <button className="btn btn-primary" onClick={openNewContact}>
                      New contact
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span className="text-sm">No contacts match</span>
                  <span className="max-w-xs text-xs font-light text-gray-400">
                    Remove a filter or search a different name.
                  </span>
                  <button className="btn mt-1 rounded-full text-xs" onClick={clearFilters}>
                    Clear filters
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* footer */}
        <div className="flex h-9 flex-none items-center justify-between border-t border-gray-200 px-6 text-[11px] font-light text-gray-400">
          <span className="tabular-nums">
            {total === 0
              ? 'No contacts'
              : `Showing ${safePage * PAGE_SIZE + 1}–${Math.min(
                  (safePage + 1) * PAGE_SIZE,
                  total
                )} of ${total}`}
          </span>
          <div className="flex items-center gap-4">
            <button
              className="text-gray-500 hover:text-gray-900 disabled:cursor-default disabled:text-gray-300"
              disabled={safePage === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Prev
            </button>
            <span className="tabular-nums">
              {safePage + 1} / {pageCount}
            </span>
            <button
              className="text-gray-500 hover:text-gray-900 disabled:cursor-default disabled:text-gray-300"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {/* ── bulk actions bar ── */}
      {selected.size > 0 && (
        <div className="anim-rise-in fixed bottom-5 left-1/2 z-30 flex h-11 -translate-x-1/2 items-center gap-4 rounded-full border border-gray-200 bg-white px-5 shadow-2xl">
          <span className="whitespace-nowrap text-xs font-semibold tabular-nums">
            {selected.size} selected
          </span>
          <span className="h-3.5 w-px bg-gray-200" />
          <label className="flex items-center gap-1.5 text-xs text-gray-600">
            Status
            <select
              className="h-6 rounded-md border border-gray-200 bg-white text-xs"
              value=""
              disabled={bulkBusy}
              onChange={(e) => {
                if (e.target.value)
                  bulkPatch(
                    { status_id: e.target.value },
                    `Status updated for ${selected.size} contacts`
                  );
              }}
            >
              <option value="">—</option>
              {statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-gray-600">
            Owner
            <select
              className="h-6 rounded-md border border-gray-200 bg-white text-xs"
              value=""
              disabled={bulkBusy}
              onChange={(e) => {
                if (e.target.value)
                  bulkPatch(
                    { owner_id: e.target.value },
                    `Owner set for ${selected.size} contacts`
                  );
              }}
            >
              <option value="">—</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name || p.email}
                </option>
              ))}
            </select>
          </label>
          {isAdmin && (
            <>
              <span className="h-3.5 w-px bg-gray-200" />
              <button
                className="text-xs font-medium text-red-600 hover:text-red-700 disabled:text-gray-300"
                disabled={bulkBusy}
                onClick={bulkDelete}
              >
                {bulkBusy ? 'Working…' : 'Delete'}
              </button>
            </>
          )}
          <span className="h-3.5 w-px bg-gray-200" />
          <button
            className="text-xs text-gray-400 hover:text-gray-900"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </button>
        </div>
      )}

      {/* ── toast ── */}
      {toast && (
        <div className="anim-pop-in fixed bottom-5 left-6 z-40 flex h-9 items-center gap-2 rounded-full border border-gray-200 bg-white px-4 text-xs shadow-xl">
          <span className="h-[5px] w-[5px] rounded-full bg-green-500" />
          <span>{toast}</span>
        </div>
      )}

      {/* ── new contact modal ── */}
      {newContact && (
        <div
          className="anim-fade-in fixed inset-0 z-40 flex items-center justify-center bg-black/20"
          onClick={() => setNewContact(null)}
        >
          <div
            className="anim-modal-in w-full max-w-md rounded-xl bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-1 text-sm font-semibold">New contact</h2>
            <p className="mb-3 text-xs text-gray-400">
              Add the links on the Link Data tab after saving — manually, or with the automatic web
              search.
            </p>
            <div className="space-y-2">
              <div>
                <label className="label">Name</label>
                <input
                  className="input"
                  autoFocus
                  value={newContact.name}
                  onChange={(e) => setNewContact({ ...newContact, name: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && saveNewContact()}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="label">Email</label>
                  <input
                    className="input"
                    type="email"
                    value={newContact.email}
                    onChange={(e) => setNewContact({ ...newContact, email: e.target.value })}
                  />
                </div>
                <div>
                  <label className="label">Phone</label>
                  <input
                    className="input"
                    value={newContact.phone}
                    onChange={(e) => setNewContact({ ...newContact, phone: e.target.value })}
                  />
                </div>
                <div>
                  <label className="label">City</label>
                  <input
                    className="input"
                    value={newContact.city}
                    onChange={(e) => setNewContact({ ...newContact, city: e.target.value })}
                  />
                </div>
                <div>
                  <label className="label">State</label>
                  <input
                    className="input"
                    value={newContact.state}
                    onChange={(e) => setNewContact({ ...newContact, state: e.target.value })}
                  />
                </div>
                <div>
                  <label className="label">County</label>
                  <input
                    className="input"
                    placeholder="If known — seeds the search"
                    value={newContact.county}
                    onChange={(e) => setNewContact({ ...newContact, county: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <label className="label">Status</label>
                <select
                  className="input"
                  value={newContact.status_id}
                  onChange={(e) => setNewContact({ ...newContact, status_id: e.target.value })}
                >
                  <option value="">— none —</option>
                  {statuses.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button className="btn" onClick={() => setNewContact(null)}>
                  Cancel
                </button>
                <button className="btn btn-primary" disabled={creating} onClick={saveNewContact}>
                  {creating ? 'Creating…' : 'Create contact'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── slide-over detail ── */}
      {selectedId && (
        <ContactPanel
          contactId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
