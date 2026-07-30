'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import {
  parseClientImportFile,
  MAX_IMPORT_FILE_BYTES,
  type ParsedClientImport,
} from '@/lib/client-import';

// Matches the /api/import/clients body limit, so an oversize roster fails here
// with a clear message instead of after a successful-looking preview.
const MAX_IMPORT_BODY_BYTES = 8 * 1024 * 1024;

async function hashKey(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Import wizard for a grouped client roster (.xlsx/.csv) → the Clients tab. */
export default function ClientImportPage() {
  const supabase = useMemo(() => createClient(), []);
  const [filename, setFilename] = useState('');
  const [parsed, setParsed] = useState<ParsedClientImport | null>(null);
  const [result, setResult] = useState<{ imported: number; totalClients: number; totalLinks: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statuses, setStatuses] = useState<{ id: string; name: string }[]>([]);
  const [statusId, setStatusId] = useState('');

  useEffect(() => {
    supabase
      .from('statuses')
      .select('id, name')
      .eq('is_client_status', true)
      .order('sort_order')
      .then(({ data }) => {
        const rows = (data ?? []) as { id: string; name: string }[];
        setStatuses(rows);
        // Default to a status named "Client", else the first flagged one.
        const preferred = rows.find((s) => s.name.trim().toLowerCase() === 'client') ?? rows[0];
        if (preferred) setStatusId(preferred.id);
      });
  }, [supabase]);

  async function handleFile(file: File) {
    setError(null);
    setResult(null);
    setParsed(null);
    try {
      if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error('Import files must be 20 MB or smaller');
      const p = await parseClientImportFile(file);
      if (!p.clients.length) throw new Error('No clients found — is this the client roster, with a "Client" (or "Name") column?');
      setFilename(file.name);
      setParsed(p);
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function runImport() {
    if (!parsed) return;
    setBusy(true);
    setError(null);
    try {
      const payload = JSON.stringify({
        filename,
        clients: parsed.clients,
        statusId: statusId || undefined,
      });
      if (payload.length > MAX_IMPORT_BODY_BYTES) {
        throw new Error('This roster is too large to import in one request — split it into smaller files.');
      }
      // Key derived from the payload, not a fresh random: re-selecting the same
      // file after a reload or a lost response reuses the key, so committed
      // clients come back from cache instead of being duplicated.
      const key = 'client-import:' + (await hashKey(payload));
      const res = await fetch('/api/import/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: payload,
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Import failed');
      else setResult(data);
    } catch (e: any) {
      // A network drop mid-import must not fail silently. The key is stable, so
      // pressing Import again resumes idempotently — committed chunks come back
      // from cache, only unfinished ones run.
      setError(`${e?.message ?? 'Import failed'} — press Import again to resume safely.`);
    } finally {
      setBusy(false);
    }
  }

  const importable = parsed?.clients.filter((c) => c.name).length ?? 0;
  const stateCount = parsed ? new Set(parsed.clients.map((c) => c.state).filter(Boolean)).size : 0;
  const grossTotal = parsed
    ? parsed.clients.reduce((sum, c) => sum + (c.grossRevenue ?? 0), 0)
    : 0;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-light tracking-tight">Import clients</h1>
      <p className="mt-1 mb-5 text-sm text-gray-500">
        Upload your client roster (<strong>.xlsx</strong> or CSV). Each client&apos;s rows are grouped
        automatically, their removal URLs become Link Data, and everyone is filed under your{' '}
        <strong>Client</strong> status. Contacts are imported from{' '}
        <Link href="/import" className="underline">
          the contacts importer
        </Link>{' '}
        instead.
      </p>

      <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-300 bg-white py-10 text-sm text-gray-500 hover:border-brand-500 hover:text-brand-600">
        <span className="text-2xl">⬆</span>
        {filename || 'Click to choose your client roster (.xlsx / .csv)'}
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
      </label>

      {error && <div className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {parsed && !result && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Clients" value={importable.toLocaleString()} />
            <Stat label="Removal links" value={parsed.totalLinks.toLocaleString()} />
            <Stat label="States" value={String(stateCount)} />
            <Stat label="Gross total" value={`$${grossTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
          </div>

          {(parsed.droppedLinks > 0 ||
            parsed.suspiciousNames.length > 0 ||
            parsed.skippedLeadingRows > 0 ||
            parsed.skippedInvalidUrls > 0 ||
            parsed.csvErrors.length > 0) && (
            <div className="mt-4 space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {parsed.droppedLinks > 0 && (
                <div>
                  <strong>{parsed.droppedLinks}</strong> link(s) past the 14-slot cap were dropped for{' '}
                  <strong>{parsed.overCapClients.join(', ')}</strong> — add those by hand after importing.
                </div>
              )}
              {parsed.suspiciousNames.length > 0 && (
                <div>
                  <strong>{parsed.suspiciousNames.length}</strong> row(s) have an unusual client name (an email or
                  single letter): {parsed.suspiciousNames.slice(0, 6).join(', ')}
                  {parsed.suspiciousNames.length > 6 ? '…' : ''}. They&apos;ll still import — relabel them after.
                </div>
              )}
              {parsed.skippedInvalidUrls > 0 && (
                <div>
                  <strong>{parsed.skippedInvalidUrls}</strong> website cell(s) weren&apos;t usable http(s) URLs
                  (notes, typos) and were skipped — check those rows in the sheet if any matter.
                </div>
              )}
              {parsed.skippedLeadingRows > 0 && (
                <div>{parsed.skippedLeadingRows} URL row(s) before the first client were skipped.</div>
              )}
              {parsed.csvErrors.length > 0 && (
                <div>
                  <strong>CSV parse issues</strong> — columns may be misaligned, which can attach links to the
                  wrong client. Check these rows: {parsed.csvErrors.join('; ')}
                </div>
              )}
            </div>
          )}

          <h2 className="mt-6 mb-2 text-sm font-semibold">
            Preview <span className="font-normal text-gray-400">(first 12 of {importable})</span>
          </h2>
          <div className="card p-0">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="grid-th">Client</th>
                  <th className="grid-th">State</th>
                  <th className="grid-th">Gross</th>
                  <th className="grid-th">Signed</th>
                  <th className="grid-th">Links</th>
                </tr>
              </thead>
              <tbody>
                {parsed.clients.filter((c) => c.name).slice(0, 12).map((c, i) => (
                  <tr key={i}>
                    <td className="grid-td font-medium">{c.name}</td>
                    <td className="grid-td">{c.state ?? '—'}</td>
                    <td className="grid-td">{c.grossRevenue != null ? `$${c.grossRevenue.toLocaleString()}` : '—'}</td>
                    <td className="grid-td">{c.signedDate ?? '—'}</td>
                    <td className="grid-td">{c.links.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-gray-600">
              Import as status
              <select
                className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm"
                value={statusId}
                onChange={(e) => setStatusId(e.target.value)}
              >
                {statuses.length === 0 && <option value="">No client status configured</option>}
                {statuses.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn-primary" disabled={busy || !statusId} onClick={runImport}>
              {busy ? 'Importing…' : `Import ${importable} clients`}
            </button>
          </div>
          {statuses.length === 0 && (
            <p className="mt-2 text-xs text-red-700">
              No client status is flagged. In Statuses &amp; Stages, tick the “client” box on your Client
              status, then reload this page.
            </p>
          )}
        </>
      )}

      {result && (
        <div className="mt-6 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800">
          Imported <strong>{result.imported}</strong> of {result.totalClients} clients with{' '}
          <strong>{result.totalLinks}</strong> removal links.
          <Link href="/clients" className="mt-1 block font-medium underline">
            Go to clients →
          </Link>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="text-xs text-gray-400">{label}</div>
      <div className="mt-0.5 text-xl font-light tracking-tight">{value}</div>
    </div>
  );
}
