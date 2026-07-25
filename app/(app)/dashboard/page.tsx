'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useMyRole } from '@/lib/use-my-role';

/**
 * Overview: reputation health, pipeline breakdown, recent activity — plus
 * revenue and Stripe figures for admins only (/api/revenue enforces the same
 * rule server-side, so a worker's browser never receives them).
 */
export default function DashboardPage() {
  const supabase = useMemo(() => createClient(), []);
  const { isAdmin } = useMyRole();
  const [metrics, setMetrics] = useState<any>({
    contacts: 0,
    average_reputation: null,
    clients: 0,
    live_links: 0,
    removed_links: 0,
    by_status: [],
  });
  const [activity, setActivity] = useState<any[]>([]);
  const [revenue, setRevenue] = useState<any>(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    supabase
      .rpc('dashboard_metrics')
      .then(({ data, error }) => {
        if (error) setLoadError(error.message);
        else if (data) setMetrics(data);
      });
    supabase
      .from('activity_log')
      .select('*, contacts ( name )')
      .order('created_at', { ascending: false })
      .limit(12)
      .then(({ data, error }) => {
        if (error) setLoadError(error.message);
        else setActivity(data ?? []);
      });
    if (isAdmin) {
      fetch('/api/revenue')
        .then((r) => (r.ok ? r.json() : null))
        .then(setRevenue)
        .catch(() => setLoadError('Could not load revenue metrics'));
    }
  }, [supabase, isAdmin]);

  const byStatus: { id: string; name: string; color: string; count: number }[] =
    metrics.by_status ?? [];
  const maxCount = Math.max(1, ...byStatus.map((s) => s.count));

  const stats: { label: string; value: any; accent?: boolean }[] = [
    { label: 'Contacts', value: metrics.contacts },
    { label: 'Avg Reputation Score', value: metrics.average_reputation ?? '—', accent: true },
    { label: 'Clients', value: metrics.clients },
    { label: 'Live links', value: metrics.live_links },
    { label: 'Links removed', value: metrics.removed_links },
  ];
  if (isAdmin) {
    stats.push({
      label: 'Projected revenue',
      value: revenue ? `$${Number(revenue.projectionTotal).toLocaleString()}` : '—',
    });
  }

  return (
    <div className="p-6">
      {loadError && (
        <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          {loadError}
        </div>
      )}
      <div className="mb-5 flex items-baseline gap-2.5">
        <h1 className="text-2xl font-light tracking-tight">Dashboard</h1>
        <span className="text-xs tabular-nums text-gray-400">
          {metrics.contacts ? `${metrics.contacts} contacts` : ''}
        </span>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {stats.map((s, i) => (
          <div
            key={s.label}
            className="card anim-rise-in"
            style={{ animationDelay: `${i * 40}ms` }}
          >
            <div className={`text-2xl font-light tabular-nums ${s.accent ? 'text-brand-700' : ''}`}>
              {s.value}
            </div>
            <div className="mt-1 text-[10px] font-medium uppercase tracking-widest text-gray-400">
              {s.label}
            </div>
          </div>
        ))}
      </div>

      <div className={`grid gap-4 ${isAdmin ? 'lg:grid-cols-2' : ''}`}>
        {/* Pipeline by status */}
        <div className="card anim-rise-in" style={{ animationDelay: '240ms' }}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[10px] font-medium uppercase tracking-widest text-gray-400">
              Pipeline by status
            </h2>
            <Link href="/contacts" className="text-xs text-gray-500 hover:text-gray-900">
              Open contacts →
            </Link>
          </div>
          <div className="space-y-2">
            {byStatus.map((s) => (
              <div key={s.id} className="flex items-center gap-2.5 text-sm">
                <span className="flex w-36 shrink-0 items-center gap-1.5 truncate text-xs text-gray-500">
                  <span
                    className="h-[5px] w-[5px] flex-none rounded-full"
                    style={{ background: s.color || '#9ca3af' }}
                  />
                  {s.name}
                </span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${(s.count / maxCount) * 100}%`,
                      backgroundColor: s.color,
                      minWidth: s.count ? 6 : 0,
                    }}
                  />
                </div>
                <span className="w-8 text-right text-xs tabular-nums">{s.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Revenue — admin only */}
        {isAdmin && (
        <div className="card anim-rise-in" style={{ animationDelay: '280ms' }}>
          <h2 className="mb-3 text-[10px] font-medium uppercase tracking-widest text-gray-400">
            Revenue
          </h2>
          {revenue?.stripe?.months?.length ? (
            <div className="space-y-1.5">
              {revenue.stripe.months.slice(-6).map((m: any) => {
                const max = Math.max(...revenue.stripe.months.map((x: any) => x.gross), 1);
                return (
                  <div key={m.month} className="flex items-center gap-2 text-sm">
                    <span className="w-16 shrink-0 font-mono text-xs text-gray-500">{m.month}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                      <div
                        className="h-full rounded-full bg-green-500"
                        style={{ width: `${(m.gross / max) * 100}%`, minWidth: m.gross ? 6 : 0 }}
                      />
                    </div>
                    <span className="w-20 text-right text-xs tabular-nums">
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
        )}
      </div>

      {/* Activity */}
      <div className="card anim-rise-in mt-4" style={{ animationDelay: '320ms' }}>
        <h2 className="mb-3 text-[10px] font-medium uppercase tracking-widest text-gray-400">
          Recent activity
        </h2>
        <div className="divide-y divide-gray-100">
          {activity.map((a) => (
            <div key={a.id} className="flex gap-3 py-1.5 text-sm">
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
