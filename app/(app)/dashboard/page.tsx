'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';

/** Overview: reputation health, pipeline breakdown, revenue, recent activity. */
export default function DashboardPage() {
  const supabase = useMemo(() => createClient(), []);
  const [contacts, setContacts] = useState<any[]>([]);
  const [statuses, setStatuses] = useState<any[]>([]);
  const [activity, setActivity] = useState<any[]>([]);
  const [revenue, setRevenue] = useState<any>(null);

  useEffect(() => {
    supabase
      .from('contacts')
      .select('id, name, status_id, reputation_score, link_score, revenue_projection, client_since, contact_links ( status, url )')
      .limit(2000)
      .then(({ data }) => setContacts(data ?? []));
    supabase
      .from('statuses')
      .select('*')
      .order('sort_order')
      .then(({ data }) => setStatuses(data ?? []));
    supabase
      .from('activity_log')
      .select('*, contacts ( name )')
      .order('created_at', { ascending: false })
      .limit(12)
      .then(({ data }) => setActivity(data ?? []));
    fetch('/api/revenue')
      .then((r) => (r.ok ? r.json() : null))
      .then(setRevenue)
      .catch(() => {});
  }, [supabase]);

  const scored = contacts.filter((c) => c.reputation_score != null);
  const avgReputation = scored.length
    ? Math.round((scored.reduce((s, c) => s + Number(c.reputation_score), 0) / scored.length) * 10) / 10
    : null;
  const clientStatusIds = new Set(statuses.filter((s) => s.is_client_status).map((s) => s.id));
  const clientCount = contacts.filter((c) => clientStatusIds.has(c.status_id)).length;
  const allLinks = contacts.flatMap((c) => c.contact_links ?? []).filter((l: any) => l.url);
  const liveLinks = allLinks.filter((l: any) => l.status === 'live').length;
  const removedLinks = allLinks.filter((l: any) => l.status === 'removed').length;

  const byStatus = statuses.map((s) => ({
    ...s,
    count: contacts.filter((c) => c.status_id === s.id).length,
  }));
  const maxCount = Math.max(1, ...byStatus.map((s) => s.count));

  const stats = [
    { label: 'Contacts', value: contacts.length },
    { label: 'Avg Reputation Score', value: avgReputation ?? '—', accent: true },
    { label: 'Clients', value: clientCount },
    { label: 'Live links', value: liveLinks },
    { label: 'Links removed', value: removedLinks },
    {
      label: 'Projected revenue',
      value: revenue ? `$${Number(revenue.projectionTotal).toLocaleString()}` : '—',
    },
  ];

  return (
    <div className="p-6">
      <h1 className="mb-5 text-lg font-semibold">Dashboard</h1>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {stats.map((s) => (
          <div key={s.label} className="card">
            <div className={`text-2xl font-bold ${s.accent ? 'text-brand-700' : ''}`}>{s.value}</div>
            <div className="mt-0.5 text-xs text-gray-500">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Pipeline by status */}
        <div className="card">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Pipeline by status</h2>
            <Link href="/contacts" className="text-xs text-brand-600 hover:underline">
              Open contacts →
            </Link>
          </div>
          <div className="space-y-1.5">
            {byStatus.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-sm">
                <span className="w-36 shrink-0 truncate text-xs text-gray-500">{s.name}</span>
                <div className="h-4 flex-1 overflow-hidden rounded bg-gray-100">
                  <div
                    className="h-full rounded"
                    style={{
                      width: `${(s.count / maxCount) * 100}%`,
                      backgroundColor: s.color,
                      minWidth: s.count ? 6 : 0,
                    }}
                  />
                </div>
                <span className="w-8 text-right font-mono text-xs">{s.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Revenue */}
        <div className="card">
          <h2 className="mb-3 text-sm font-semibold">Revenue</h2>
          {revenue?.stripe?.months?.length ? (
            <div className="space-y-1.5">
              {revenue.stripe.months.slice(-6).map((m: any) => {
                const max = Math.max(...revenue.stripe.months.map((x: any) => x.gross), 1);
                return (
                  <div key={m.month} className="flex items-center gap-2 text-sm">
                    <span className="w-16 shrink-0 font-mono text-xs text-gray-500">{m.month}</span>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-gray-100">
                      <div
                        className="h-full rounded bg-green-500"
                        style={{ width: `${(m.gross / max) * 100}%`, minWidth: m.gross ? 6 : 0 }}
                      />
                    </div>
                    <span className="w-20 text-right font-mono text-xs">
                      ${m.gross.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                );
              })}
              <div className="pt-1 text-xs text-gray-400">Stripe gross by month</div>
            </div>
          ) : (
            <div className="text-sm text-gray-400">
              {revenue?.stripeError
                ? `Stripe: ${revenue.stripeError}`
                : 'Connect Stripe under Admin → Integrations to see actual revenue.'}
            </div>
          )}
          {revenue?.topProjections?.length > 0 && (
            <div className="mt-4">
              <div className="label">Top projected clients</div>
              {revenue.topProjections.slice(0, 5).map((c: any) => (
                <div key={c.id} className="flex justify-between text-sm">
                  <span className="truncate">{c.name}</span>
                  <span className="font-mono text-green-700">
                    ${Number(c.revenue_projection).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Activity */}
      <div className="card mt-4">
        <h2 className="mb-3 text-sm font-semibold">Recent activity</h2>
        <div className="space-y-2">
          {activity.map((a) => (
            <div key={a.id} className="flex gap-3 text-sm">
              <span className="w-36 shrink-0 text-xs text-gray-400">
                {new Date(a.created_at).toLocaleString()}
              </span>
              <span className="w-24 shrink-0 truncate text-xs font-medium text-gray-500">
                {a.contacts?.name ?? '—'}
              </span>
              <span className="truncate">{a.description}</span>
            </div>
          ))}
          {activity.length === 0 && <div className="text-sm text-gray-400">Nothing yet.</div>}
        </div>
      </div>
    </div>
  );
}
