'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

const LEVEL_STYLES: Record<string, string> = {
  error: 'bg-red-100 text-red-700',
  warn: 'bg-amber-100 text-amber-700',
  info: 'bg-gray-100 text-gray-600',
};

/**
 * Admin: every recorded failure in one place. Reads debug_log directly —
 * RLS restricts SELECT to admins, so no separate API route is needed.
 */
export default function DebugLogPage() {
  const supabase = useMemo(() => createClient(), []);
  const [entries, setEntries] = useState<any[]>([]);
  const [level, setLevel] = useState('');
  const [source, setSource] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    let query = supabase
      .from('debug_log')
      .select('*, contacts ( name )')
      .order('created_at', { ascending: false })
      .limit(200);
    if (level) query = query.eq('level', level);
    if (source) query = query.ilike('source', `%${source}%`);
    const { data } = await query;
    setEntries(data ?? []);
    setLoading(false);
  }, [supabase, level, source]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    // 30s, and only while the tab is visible. A forgotten background tab
    // polling every 5s was a permanent request stream that kept the host's
    // worker pool warm and multiplying — part of the idle-process pileup.
    const tick = () => {
      if (document.visibilityState === 'visible') load();
    };
    const t = setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [autoRefresh, load]);

  const sources = [...new Set(entries.map((e) => e.source))].sort();
  const errorCount = entries.filter((e) => e.level === 'error').length;

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Debug Log</h1>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-gray-500">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh
          </label>
          <button className="btn py-1" onClick={load}>
            Refresh
          </button>
          <button
            className="btn py-1 text-red-600"
            onClick={async () => {
              if (!confirm('Clear all debug log entries?')) return;
              await supabase.from('debug_log').delete().neq('id', '00000000-0000-0000-0000-000000000000');
              load();
            }}
          >
            Clear
          </button>
        </div>
      </div>
      <p className="mb-4 text-xs text-gray-400">
        Integration and delivery failures, newest first. Entries older than 14 days are pruned
        automatically by the cron tick.
      </p>

      <div className="mb-3 flex items-center gap-2">
        <select className="input w-36" value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">All levels</option>
          <option value="error">Errors</option>
          <option value="warn">Warnings</option>
          <option value="info">Info</option>
        </select>
        <select className="input w-56" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">All sources</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-gray-400">
          {loading ? 'Loading…' : `${entries.length} entries · ${errorCount} errors`}
        </span>
      </div>

      <div className="card p-0">
        <table className="w-full">
          <thead>
            <tr>
              <th className="grid-th">When</th>
              <th className="grid-th">Level</th>
              <th className="grid-th">Source</th>
              <th className="grid-th">Message</th>
              <th className="grid-th">Contact</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <Fragment key={e.id}>
                <tr
                  className="grid-row"
                  onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                >
                  <td className="grid-td whitespace-nowrap text-gray-400">
                    {new Date(e.created_at).toLocaleString()}
                  </td>
                  <td className="grid-td">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        LEVEL_STYLES[e.level] ?? LEVEL_STYLES.info
                      }`}
                    >
                      {e.level}
                    </span>
                  </td>
                  <td className="grid-td font-mono text-xs">{e.source}</td>
                  <td className="grid-td max-w-md truncate">{e.message}</td>
                  <td className="grid-td text-gray-500">{e.contacts?.name ?? ''}</td>
                </tr>
                {expanded === e.id && (
                  <tr>
                    <td colSpan={5} className="border-b border-gray-100 bg-gray-50 px-3 py-2">
                      <div className="mb-1 text-xs font-semibold text-gray-500">Message</div>
                      <div className="mb-2 font-mono text-xs break-all whitespace-pre-wrap">
                        {e.message}
                      </div>
                      <div className="mb-1 text-xs font-semibold text-gray-500">Context</div>
                      <pre className="overflow-x-auto font-mono text-xs">
                        {JSON.stringify(e.context, null, 2)}
                      </pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {!loading && entries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-sm text-gray-400">
                  Nothing logged — no failures recorded.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
