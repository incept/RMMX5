'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import StatusPill, { type StatusOption } from '@/components/StatusPill';
import ContactPanel from '@/components/ContactPanel';

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
  created_at: string;
  statuses: (StatusOption & { is_client_status?: boolean }) | null;
  contact_links: { id: string; url: string; status: string }[];
}

interface Profile {
  id: string;
  full_name: string | null;
  email: string | null;
}

type SortKey = 'name' | 'created_at' | 'reputation_score' | 'link_score' | 'status';
type ViewId = 'all' | 'mine' | 'clients' | 'flagged' | 'recent';
type DetailMode = 'panel' | 'modal' | 'page';

interface NewContactDraft {
  name: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  status_id: string;
}

/** Columns the ⚙ menu can show/hide. Name is always on. */
const COL_DEFS = [
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['location', 'Location'],
  ['status', 'Status'],
  ['rep', 'Rep Score'],
  ['link', 'Link Score'],
  ['links', 'Live Links'],
  ['owner', 'Owner'],
  ['created', 'Created'],
] as const;
type ColKey = (typeof COL_DEFS)[number][0];
const DEFAULT_COLS: Record<ColKey, boolean> = {
  email: true, phone: true, location: true, status: true, rep: true,
  link: true, links: true, owner: false, created: true,
};

const PAGE_SIZE = 50;
const COLS_LS = 'rmmx5-contact-cols';
const MODE_LS = 'rmmx5-detail-mode';

/**
 * The main CRM view, relaid out after the iCRM design study: saved views with
 * counts, status dot-filters, a column picker, inline email editing, bulk
 * actions on a floating bar, and a Panel / Modal / Page detail switcher —
 * all on the app's existing light/dark token palette.
 */
export default function ContactsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [statuses, setStatuses] = useState<(StatusOption & { is_client_status?: boolean })[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ViewId>('all');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [sortAsc, setSortAsc] = useState(false);
  const [cols, setCols] = useState<Record<ColKey, boolean>>(DEFAULT_COLS);
  const [colMenu, setColMenu] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [editEmailId, setEditEmailId] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState('');
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [detailMode, setDetailMode] = useState<DetailMode>('panel');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newContact, setNewContact] = useState<NewContactDraft | null>(null);
  const [creating, setCreating] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  /* ── persisted prefs ── */
  useEffect(() => {
    try {
      const c = localStorage.getItem(COLS_LS);
      if (c) setCols({ ...DEFAULT_COLS, ...JSON.parse(c) });
      const m = localStorage.getItem(MODE_LS) as DetailMode | null;
      if (m === 'panel' || m === 'modal' || m === 'page') setDetailMode(m);
    } catch {
      /* corrupted prefs — defaults are fine */
    }
  }, []);
  function setCol(key: ColKey, on: boolean) {
    setCols((c) => {
      const next = { ...c, [key]: on };
      localStorage.setItem(COLS_LS, JSON.stringify(next));
      return next;
    });
  }
  function pickMode(m: DetailMode) {
    setDetailMode(m);
    localStorage.setItem(MODE_LS, m);
  }

  function flash(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2400);
  }

  /* ── data ── */
  const load = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from('contacts')
      .select(
        'id, name, city, state, email, phone, status_id, owner_id, reputation_score, link_score, search_flag, created_at, statuses ( id, name, color, is_client_status ), contact_links ( id, url, status )'
      )
      .limit(1000);

    if (search.trim()) {
      const q = search.trim().replace(/[%,]/g, '');
      query = query.or(`name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`);
    }

    const { data } = await query;
    setContacts((data as any) ?? []);
    setLoading(false);
  }, [supabase, search]);

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
    supabase.auth.getUser().then(({ data }) => setMeId(data.user?.id ?? null));
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
  const weekAgo = useMemo(() => Date.now() - 7 * 24 * 3600 * 1000, []);
  const viewDefs: { id: ViewId; label: string; test: (c: ContactRow) => boolean }[] = useMemo(
    () => [
      { id: 'all', label: 'All', test: () => true },
      { id: 'mine', label: 'My contacts', test: (c) => !!meId && c.owner_id === meId },
      { id: 'clients', label: 'Clients', test: (c) => !!c.statuses?.is_client_status },
      { id: 'flagged', label: '⚑ Flagged', test: (c) => !!c.search_flag },
      { id: 'recent', label: 'New this week', test: (c) => new Date(c.created_at).getTime() >= weekAgo },
    ],
    [meId, weekAgo]
  );

  const viewCounts = useMemo(() => {
    const counts = {} as Record<ViewId, number>;
    for (const v of viewDefs) counts[v.id] = contacts.filter(v.test).length;
    return counts;
  }, [contacts, viewDefs]);

  const filtered = useMemo(() => {
    const def = viewDefs.find((v) => v.id === view) ?? viewDefs[0];
    let rows = contacts.filter(def.test);
    if (statusFilter) rows = rows.filter((c) => c.status_id === statusFilter);
    return rows;
  }, [contacts, view, statusFilter, viewDefs]);

  const sorted = useMemo(() => {
    const rows = [...filtered];
    rows.sort((a, b) => {
      let va: any;
      let vb: any;
      switch (sortKey) {
        case 'status':
          va = a.statuses?.name ?? '';
          vb = b.statuses?.name ?? '';
          break;
        default:
          va = a[sortKey] ?? '';
          vb = b[sortKey] ?? '';
      }
      if (typeof va === 'number' || typeof vb === 'number') {
        return (Number(va) - Number(vb)) * (sortAsc ? 1 : -1);
      }
      return String(va).localeCompare(String(vb)) * (sortAsc ? 1 : -1);
    });
    return rows;
  }, [filtered, sortKey, sortAsc]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
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
  const SORT_LABELS: Record<SortKey, string> = {
    name: 'name', created_at: 'created', reputation_score: 'rep score',
    link_score: 'link score', status: 'status',
  };

  /* ── selection + bulk actions ── */
  const visibleIds = sorted.map((c) => c.id);
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

  /* ── new contact modal (unchanged behavior) ── */
  function openNewContact() {
    setNewContact({
      name: '', email: '', phone: '', city: '', state: '',
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

  /* ── header cell helper ── */
  const th = (label: string, key?: SortKey, extra = '') => (
    <div
      className={`flex items-center gap-1.5 ${extra} ${key ? 'cursor-pointer hover:text-gray-700' : ''}`}
      onClick={key ? () => toggleSort(key) : undefined}
    >
      {label}
      {key && sortKey === key && <span className="text-gray-900">{sortAsc ? '↑' : '↓'}</span>}
    </div>
  );

  const showPageDetail = !!selectedId && detailMode === 'page';
  const skeletonWidths = [190, 150, 210, 170, 140, 200, 160, 180];

  return (
    <div className="flex h-full flex-col">
      {/* ── Title row ── */}
      <div className="flex flex-none flex-wrap items-center gap-4 px-6 pt-5">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-2xl font-light tracking-tight">Contacts</h1>
          <span className="text-xs tabular-nums text-gray-400">
            {loading
              ? '…'
              : sorted.length === contacts.length
                ? `${contacts.length} total`
                : `${sorted.length} of ${contacts.length}`}
          </span>
        </div>
        <div className="flex-1" />
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="h-8 w-52 rounded-full border-0 bg-gray-100 px-4 text-xs outline-none placeholder:text-gray-400 focus:ring-2 focus:ring-brand-500/40"
            placeholder="Search name, email, phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="relative">
            <button
              className="h-8 rounded-full px-3 text-xs text-gray-500 hover:text-gray-900"
              onClick={() => setColMenu((v) => !v)}
            >
              Columns
            </button>
            {colMenu && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setColMenu(false)} />
                <div className="anim-pop-in absolute right-0 top-9 z-30 w-48 rounded-xl border border-gray-200 bg-white p-2 shadow-xl">
                  <div className="px-2 pb-1.5 pt-1 text-[10px] font-medium uppercase tracking-widest text-gray-400">
                    Columns
                  </div>
                  {COL_DEFS.map(([key, label]) => (
                    <button
                      key={key}
                      className={`flex h-7 w-full items-center justify-between rounded-lg px-2 text-left text-xs hover:bg-gray-50 ${
                        cols[key] ? 'text-gray-900' : 'text-gray-400'
                      }`}
                      onClick={() => setCol(key, !cols[key])}
                    >
                      <span>{label}</span>
                      <span className="text-gray-500">{cols[key] ? '✓' : ''}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <Link href="/import" className="h-8 rounded-full px-3 text-xs leading-8 text-gray-500 hover:text-gray-900">
            Import
          </Link>
          <button
            className="h-8 rounded-full bg-red-600 px-4 text-xs font-medium text-white transition hover:bg-red-700 hover:shadow-md active:scale-95"
            onClick={openNewContact}
          >
            New contact
          </button>
        </div>
      </div>

      {/* ── Views + status dot filters ── */}
      <div className="flex flex-none flex-wrap items-center gap-4 px-6 pb-3 pt-3.5">
        <div className="flex flex-wrap items-center gap-4">
          {viewDefs.map((v) => (
            <button
              key={v.id}
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
        <div className="flex flex-wrap items-center gap-3.5">
          <button
            className={`inline-flex items-center gap-1.5 text-xs ${
              statusFilter === '' ? 'text-gray-900' : 'text-gray-400 hover:text-gray-900'
            }`}
            onClick={() => setStatusFilter('')}
          >
            <span className="h-[5px] w-[5px] flex-none rounded-full bg-gray-300" />
            Any
          </button>
          {statuses.map((s) => (
            <button
              key={s.id}
              className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs ${
                statusFilter === s.id ? 'text-gray-900' : 'text-gray-400 hover:text-gray-900'
              }`}
              onClick={() => setStatusFilter(statusFilter === s.id ? '' : s.id)}
            >
              <span
                className="h-[5px] w-[5px] flex-none rounded-full"
                style={{ background: s.color || '#9ca3af' }}
              />
              {s.name}
            </button>
          ))}
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
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-gray-400">
            Sorted by {SORT_LABELS[sortKey]} {sortAsc ? '↑' : '↓'}
          </span>
          <span className="h-3.5 w-px bg-gray-200" />
          <span className="text-[11px] text-gray-400">Detail</span>
          {(['panel', 'modal', 'page'] as DetailMode[]).map((m) => (
            <button
              key={m}
              className={`text-[11px] capitalize ${
                detailMode === m
                  ? 'text-gray-900 shadow-[inset_0_-1px_0_currentColor]'
                  : 'text-gray-400 hover:text-gray-900'
              }`}
              onClick={() => pickMode(m)}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* ── Page-mode detail replaces the grid ── */}
      {showPageDetail ? (
        <div className="min-h-0 flex-1 overflow-auto border-t border-gray-200 px-6 py-4">
          <div className="mx-auto flex h-full max-w-5xl flex-col gap-3">
            <button
              className="self-start text-xs text-gray-500 hover:text-gray-900"
              onClick={() => setSelectedId(null)}
            >
              ← All contacts
            </button>
            <div className="min-h-0 flex-1">
              <ContactPanel
                contactId={selectedId!}
                mode="page"
                onClose={() => setSelectedId(null)}
                onChanged={load}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col border-t border-gray-200">
          <div className="min-h-0 flex-1 overflow-auto">
            <div className="min-w-[1080px]">
              {/* mini header */}
              <div className="sticky top-0 z-10 flex h-8 items-center border-b border-gray-200 bg-canvas px-6 text-[10px] font-medium uppercase tracking-widest text-gray-400">
                <div className="w-8 flex-none">
                  <button
                    className={`flex h-[13px] w-[13px] items-center justify-center rounded border text-[9px] leading-none transition hover:scale-110 ${
                      allOn
                        ? 'border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900'
                        : 'border-gray-300 bg-transparent text-transparent'
                    }`}
                    onClick={toggleAll}
                  >
                    ✓
                  </button>
                </div>
                <div className="min-w-[220px] flex-1">{th('Contact', 'name')}</div>
                {cols.email && <div className="w-52 flex-none">Email</div>}
                {cols.phone && <div className="w-32 flex-none">Phone</div>}
                {cols.location && <div className="w-36 flex-none">Location</div>}
                {cols.status && <div className="w-36 flex-none">{th('Status', 'status')}</div>}
                {cols.rep && <div className="w-20 flex-none">{th('Rep', 'reputation_score')}</div>}
                {cols.link && <div className="w-20 flex-none">{th('Links', 'link_score')}</div>}
                {cols.links && <div className="w-16 flex-none">Live</div>}
                {cols.owner && <div className="w-28 flex-none">Owner</div>}
                {cols.created && <div className="w-24 flex-none">{th('Created', 'created_at')}</div>}
              </div>

              {/* rows */}
              {!loading &&
                pageRows.map((contact, i) => {
                  const isSel = selected.has(contact.id);
                  const liveLinks = contact.contact_links.filter(
                    (l) => l.url && l.status === 'live'
                  ).length;
                  return (
                    <div
                      key={contact.id}
                      className={`anim-row-in flex h-[34px] items-center border-b border-gray-100 px-6 transition-colors hover:bg-gray-50 ${
                        isSel ? 'bg-gray-50' : ''
                      }`}
                      style={{ animationDelay: `${Math.min(i * 20, 320)}ms` }}
                    >
                      <div className="w-8 flex-none">
                        <button
                          className={`flex h-[13px] w-[13px] items-center justify-center rounded border text-[9px] leading-none transition hover:scale-110 ${
                            isSel
                              ? 'border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900'
                              : 'border-gray-300 bg-transparent text-transparent'
                          }`}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleOne(contact.id);
                          }}
                        >
                          ✓
                        </button>
                      </div>
                      <div
                        className="flex min-w-[220px] flex-1 cursor-pointer items-baseline gap-2.5 pr-3"
                        onClick={() => setSelectedId(contact.id)}
                      >
                        {contact.search_flag && (
                          <span className="cursor-help text-amber-500" title={`Search needs a re-run: ${contact.search_flag}`}>
                            ⚑
                          </span>
                        )}
                        <span className="whitespace-nowrap text-xs font-medium">{contact.name}</span>
                        <span className="truncate text-[11px] font-light text-gray-400">
                          {[contact.city, contact.state].filter(Boolean).join(', ')}
                        </span>
                      </div>
                      {cols.email && (
                        <div className="w-52 flex-none pr-3">
                          {editEmailId === contact.id ? (
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
                          )}
                        </div>
                      )}
                      {cols.phone && (
                        <div className="w-32 flex-none truncate text-xs font-light text-gray-500">
                          {contact.phone}
                        </div>
                      )}
                      {cols.location && (
                        <div className="w-36 flex-none truncate text-xs font-light text-gray-500">
                          {[contact.city, contact.state].filter(Boolean).join(', ')}
                        </div>
                      )}
                      {cols.status && (
                        <div className="w-36 flex-none" onClick={(e) => e.stopPropagation()}>
                          <StatusPill
                            status={contact.statuses}
                            options={statuses}
                            onChange={(statusId) => setStatus(contact.id, statusId)}
                          />
                        </div>
                      )}
                      {cols.rep && (
                        <div className="w-20 flex-none text-xs tabular-nums">
                          {contact.reputation_score != null && (
                            <span
                              className={`font-medium ${
                                Number(contact.reputation_score) >= 70
                                  ? 'text-green-600'
                                  : Number(contact.reputation_score) >= 40
                                    ? 'text-amber-600'
                                    : 'text-red-600'
                              }`}
                            >
                              {contact.reputation_score}
                            </span>
                          )}
                        </div>
                      )}
                      {cols.link && (
                        <div className="w-20 flex-none text-xs tabular-nums text-gray-500">
                          {contact.link_score}
                        </div>
                      )}
                      {cols.links && (
                        <div className="w-16 flex-none text-xs text-gray-500">{liveLinks || ''}</div>
                      )}
                      {cols.owner && (
                        <div className="w-28 flex-none truncate text-xs font-light text-gray-500">
                          {ownerName(contact.owner_id)}
                        </div>
                      )}
                      {cols.created && (
                        <div className="w-24 flex-none text-xs font-light text-gray-400">
                          {new Date(contact.created_at).toLocaleDateString()}
                        </div>
                      )}
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
                      <Link href="/import" className="btn">Import CSV</Link>
                      <button className="btn btn-primary" onClick={openNewContact}>New contact</button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="text-sm">No contacts match</span>
                    <span className="max-w-xs text-xs font-light text-gray-400">
                      Remove a filter or search a different name.
                    </span>
                    <button
                      className="btn mt-1 rounded-full text-xs"
                      onClick={clearFilters}
                    >
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
              {sorted.length === 0
                ? 'No contacts'
                : `Showing ${safePage * PAGE_SIZE + 1}–${Math.min(
                    (safePage + 1) * PAGE_SIZE,
                    sorted.length
                  )} of ${sorted.length}`}
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
      )}

      {/* ── bulk actions bar ── */}
      {selected.size > 0 && !showPageDetail && (
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
                if (e.target.value) bulkPatch({ status_id: e.target.value }, `Status updated for ${selected.size} contacts`);
              }}
            >
              <option value="">—</option>
              {statuses.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
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
                if (e.target.value) bulkPatch({ owner_id: e.target.value }, `Owner set for ${selected.size} contacts`);
              }}
            >
              <option value="">—</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.full_name || p.email}</option>
              ))}
            </select>
          </label>
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

      {/* ── new contact modal (unchanged) ── */}
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
              Add the links on the Link Data tab after saving — manually, or with the automatic
              web search.
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
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button className="btn" onClick={() => setNewContact(null)}>Cancel</button>
                <button className="btn btn-primary" disabled={creating} onClick={saveNewContact}>
                  {creating ? 'Creating…' : 'Create contact'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── panel / modal detail ── */}
      {selectedId && detailMode !== 'page' && (
        <ContactPanel
          contactId={selectedId}
          mode={detailMode}
          onClose={() => setSelectedId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
