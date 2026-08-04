'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  parseImportFile,
  suggestMapping,
  customFieldTargets,
  IMPORT_TARGETS,
  MAX_IMPORT_FILE_BYTES,
  type ParsedSheet,
} from '@/lib/monday-import';

/** Import wizard: upload Monday.com export (.xlsx) or CSV → map columns → import. */
export default function ImportPage() {
  const [filename, setFilename] = useState('');
  const [sheet, setSheet] = useState<ParsedSheet | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestKey, setRequestKey] = useState('');
  const [customFields, setCustomFields] = useState<{ field_key: string; label: string }[]>([]);

  // Admin-defined custom fields become extra mapping targets, so a sheet column
  // can flow into the same per-contact custom values the contact panel shows.
  useEffect(() => {
    const supabase = createClient();
    supabase
      .from('custom_fields')
      .select('field_key, label')
      .order('sort_order')
      .then(({ data }) => setCustomFields(data ?? []));
  }, []);

  const customTargets = useMemo(() => customFieldTargets(customFields), [customFields]);

  async function handleFile(file: File) {
    setError(null);
    setResult(null);
    try {
      if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error('Import files must be 20 MB or smaller');
      const parsed = await parseImportFile(file);
      setFilename(file.name);
      setRequestKey(crypto.randomUUID());
      setSheet(parsed);
      setMapping(suggestMapping(parsed.headers, customFields));
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function runImport() {
    if (!sheet) return;
    setBusy(true);
    setError(null);

    // Re-key each row from sheet headers to CRM field keys.
    const rows = sheet.rows.map((row) => {
      const out: Record<string, string> = {};
      for (const [header, target] of Object.entries(mapping)) {
        if (target && row[header] != null) out[target] = row[header];
      }
      return out;
    });

    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestKey },
      body: JSON.stringify({
        filename,
        source: /\.csv$/i.test(filename) ? 'csv' : 'monday',
        mapping,
        rows,
      }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) setError(data.error ?? 'Import failed');
    else setResult(data);
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-light tracking-tight">Import contacts</h1>
      <p className="mt-1 mb-5 text-sm text-gray-500">
        Upload a <strong>Monday.com board export</strong> (.xlsx) or any CSV. Group rows and
        repeated headers in Monday exports are handled automatically.
      </p>

      <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-300 bg-white py-10 text-sm text-gray-500 hover:border-brand-500 hover:text-brand-600">
        <span className="text-2xl">⬆</span>
        {filename || 'Click to choose a .xlsx / .csv file'}
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
      </label>

      {error && (
        <div className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {sheet && !result && (
        <>
          <h2 className="mt-6 mb-2 text-sm font-semibold">
            Map columns <span className="font-normal text-gray-400">({sheet.rows.length} rows found)</span>
          </h2>
          <div className="card p-0">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="grid-th">Sheet column</th>
                  <th className="grid-th">Sample</th>
                  <th className="grid-th">Imports to</th>
                </tr>
              </thead>
              <tbody>
                {sheet.headers.map((header) => (
                  <tr key={header}>
                    <td className="grid-td font-medium">{header}</td>
                    <td className="grid-td max-w-48 truncate text-gray-400">
                      {sheet.rows[0]?.[header] ?? ''}
                    </td>
                    <td className="grid-td">
                      <select
                        className="input"
                        value={mapping[header] ?? ''}
                        onChange={(e) =>
                          setMapping((m) => ({ ...m, [header]: e.target.value }))
                        }
                      >
                        {IMPORT_TARGETS.filter((t) => t.key).map((t) => (
                          <option key={t.key} value={t.key}>
                            {t.label}
                          </option>
                        ))}
                        {customTargets.length > 0 && (
                          <optgroup label="Custom fields">
                            {customTargets.map((t) => (
                              <option key={t.key} value={t.key}>
                                {t.label}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        <option value="">— skip —</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn btn-primary mt-4" disabled={busy} onClick={runImport}>
            {busy ? 'Importing…' : `Import ${sheet.rows.length} contacts`}
          </button>
        </>
      )}

      {result && (
        <div className="mt-6 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800">
          Imported <strong>{result.imported}</strong> of {result.total} rows.
          {result.errors?.length > 0 && (
            <div className="mt-1 text-red-700">Errors: {result.errors.join(' | ')}</div>
          )}
          <a href="/contacts" className="mt-1 block font-medium underline">
            Go to contacts →
          </a>
        </div>
      )}
    </div>
  );
}
