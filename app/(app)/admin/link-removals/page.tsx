'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Confirmation queue for the automated link re-check. Each row is a client
 * removal link the scan read as gone 3 times in a row; the operator confirms the
 * flip to "removed" (which notifies the client) or dismisses a false positive.
 */
export default function LinkRemovalsPage() {
  const [candidates, setCandidates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/link-removals', { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not load the queue');
      setCandidates(body.candidates ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the queue');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(linkId: string, action: 'confirm' | 'dismiss') {
    setBusy(linkId);
    setError('');
    try {
      const res = await fetch('/api/link-removals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkId, action }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Action failed');
      // Drop the row locally; it's no longer an open candidate.
      setCandidates((rows) => rows.filter((r) => r.id !== linkId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
      load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-light tracking-tight">Link removals</h1>
      <p className="mt-1 text-sm text-gray-500">
        Client removal links the re-check read as gone three times in a row. Confirm to mark them
        removed (which notifies the client), or dismiss if the page is still up.
      </p>

      {error && (
        <div className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
      )}

      <div className="mt-5 space-y-2">
        {loading && <div className="text-sm text-gray-400">Loading…</div>}
        {!loading && candidates.length === 0 && !error && (
          <div className="card text-center text-sm text-gray-400">
            Nothing to review — no detected removals right now.
          </div>
        )}
        {candidates.map((c) => (
          <div key={c.id} className="card flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{c.contact?.name ?? 'Unknown client'}</div>
              <a
                href={c.url}
                target="_blank"
                rel="noreferrer noopener"
                className="block truncate text-xs text-brand-700 hover:underline"
                title={c.url}
              >
                {c.url}
              </a>
              <div className="mt-0.5 text-[11px] text-gray-400">
                {c.goneStreak} consecutive gone reads · last checked{' '}
                {c.lastCheckedAt ? new Date(c.lastCheckedAt).toLocaleString() : '—'}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                className="btn btn-primary py-1"
                disabled={busy === c.id}
                onClick={() => act(c.id, 'confirm')}
              >
                {busy === c.id ? '…' : 'Confirm removed'}
              </button>
              <button
                className="btn py-1"
                disabled={busy === c.id}
                onClick={() => act(c.id, 'dismiss')}
                title="False positive — keep it requested and keep checking"
              >
                Still up
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
