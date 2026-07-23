'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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
  reputation_score: number | null;
  link_score: number | null;
  created_at: string;
  statuses: StatusOption | null;
  contact_links: { id: string; url: string; status: string }[];
}

type SortKey = 'name' | 'created_at' | 'reputation_score' | 'link_score' | 'status';

/** The main CRM view: spreadsheet-style grid with search, filter, sort, inline status. */
export default function ContactsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [statuses, setStatuses] = useState<StatusOption[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [sortAsc, setSortAsc] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from('contacts')
      .select(
        'id, name, city, state, email, phone, status_id, reputation_score, link_score, created_at, statuses ( id, name, color ), contact_links ( id, url, status )'
      )
      .limit(1000);

    if (search.trim()) {
      const q = search.trim().replace(/[%,]/g, '');
      query = query.or(`name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`);
    }
    if (statusFilter) query = query.eq('status_id', statusFilter);

    const { data } = await query;
    setContacts((data as any) ?? []);
    setLoading(false);
  }, [supabase, search, statusFilter]);

  useEffect(() => {
    const t = setTimeout(load, search ? 250 : 0); // debounce typing
    return () => clearTimeout(t);
  }, [load, search]);

  useEffect(() => {
    supabase
      .from('statuses')
      .select('id, name, color')
      .order('sort_order')
      .then(({ data }) => setStatuses(data ?? []));
  }, [supabase]);

  const sorted = useMemo(() => {
    const rows = [...contacts];
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
  }, [contacts, sortKey, sortAsc]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(key === 'name');
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

  async function addContact() {
    const newStatus = statuses.find((s) => s.name === 'New');
    const { data } = await supabase
      .from('contacts')
      .insert({ name: 'New contact', status_id: newStatus?.id ?? null })
      .select('id')
      .single();
    if (data) {
      await load();
      setSelectedId(data.id);
    }
  }

  const header = (label: string, key?: SortKey) => (
    <th
      className={`grid-th ${key ? 'cursor-pointer hover:text-gray-800' : ''}`}
      onClick={key ? () => toggleSort(key) : undefined}
    >
      {label}
      {key && sortKey === key && <span className="ml-1">{sortAsc ? '↑' : '↓'}</span>}
    </th>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-3">
        <h1 className="mr-2 text-lg font-semibold">Contacts</h1>
        <input
          className="input max-w-xs"
          placeholder="Search name, email, phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="input w-44"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-gray-400">
            {loading ? 'Loading…' : `${sorted.length} contact${sorted.length === 1 ? '' : 's'}`}
          </span>
          <Link href="/import" className="btn">
            Import
          </Link>
          <button className="btn btn-primary" onClick={addContact}>
            + New contact
          </button>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {header('Name', 'name')}
              {header('Status', 'status')}
              {header('Email')}
              {header('Phone')}
              {header('City')}
              {header('State')}
              {header('Rep Score', 'reputation_score')}
              {header('Link Score', 'link_score')}
              {header('Live Links')}
              {header('Created', 'created_at')}
            </tr>
          </thead>
          <tbody>
            {sorted.map((contact) => {
              const liveLinks = contact.contact_links.filter(
                (l) => l.url && l.status === 'live'
              ).length;
              return (
                <tr
                  key={contact.id}
                  className="grid-row"
                  onClick={() => setSelectedId(contact.id)}
                >
                  <td className="grid-td font-medium">{contact.name}</td>
                  <td className="grid-td" onClick={(e) => e.stopPropagation()}>
                    <StatusPill
                      status={contact.statuses}
                      options={statuses}
                      onChange={(statusId) => setStatus(contact.id, statusId)}
                    />
                  </td>
                  <td className="grid-td text-gray-500">{contact.email}</td>
                  <td className="grid-td text-gray-500">{contact.phone}</td>
                  <td className="grid-td text-gray-500">{contact.city}</td>
                  <td className="grid-td text-gray-500">{contact.state}</td>
                  <td className="grid-td">
                    {contact.reputation_score != null && (
                      <span
                        className={`font-mono font-medium ${
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
                  </td>
                  <td className="grid-td font-mono text-gray-500">{contact.link_score}</td>
                  <td className="grid-td text-gray-500">{liveLinks || ''}</td>
                  <td className="grid-td text-gray-400">
                    {new Date(contact.created_at).toLocaleDateString()}
                  </td>
                </tr>
              );
            })}
            {!loading && sorted.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-16 text-center text-sm text-gray-400">
                  No contacts yet — add one or <Link href="/import" className="text-brand-600 underline">import from Monday.com</Link>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

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
