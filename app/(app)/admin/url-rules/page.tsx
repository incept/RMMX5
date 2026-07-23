'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

/**
 * Admin: URL rules — the single source of truth for link scoring, removal
 * difficulty, removal pricing (revenue projection), and which domains count
 * as "relevant" when the automatic Google search filters results.
 */
export default function UrlRulesPage() {
  const supabase = useMemo(() => createClient(), []);
  const [rules, setRules] = useState<any[]>([]);
  const [vendors, setVendors] = useState<any[]>([]);
  const [form, setForm] = useState<any>(null);

  const load = useCallback(async () => {
    const [r, v] = await Promise.all([
      supabase.from('url_rules').select('*, vendors ( name )').order('pattern'),
      supabase.from('vendors').select('id, name').order('name'),
    ]);
    setRules(r.data ?? []);
    setVendors(v.data ?? []);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    const f = form;
    if (!f.pattern) return alert('Domain/pattern required');
    const row = {
      pattern: f.pattern.trim(),
      name: f.name || null,
      difficulty: Math.min(10, Math.max(1, Number(f.difficulty ?? 5))),
      score_weight: Number(f.score_weight ?? 10),
      removal_price: Number(f.removal_price ?? 0),
      relevant: !!f.relevant,
      vendor_id: f.vendor_id || null,
      notes: f.notes || null,
    };
    const { error } = f.id
      ? await supabase.from('url_rules').update(row).eq('id', f.id)
      : await supabase.from('url_rules').insert(row);
    if (error) return alert(error.message);
    setForm(null);
    load();
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-lg font-semibold">URL Rules & Scoring</h1>
        <button
          className="btn btn-primary"
          onClick={() => setForm({ difficulty: 5, score_weight: 10, removal_price: 0, relevant: true })}
        >
          + Add rule
        </button>
      </div>
      <p className="mb-4 max-w-3xl text-xs text-gray-400">
        Each rule matches URLs containing the pattern (e.g. <code>mugshots.com</code>). Weight
        lowers a contact's Reputation Score while the link is live; price feeds the revenue
        projection; difficulty (1–10) rates how hard removal is; "relevant" keeps the domain when
        the automatic Google search filters results. Live links on unlisted domains cost a default
        weight of 10.
      </p>

      <div className="card p-0">
        <table className="w-full">
          <thead>
            <tr>
              <th className="grid-th">Pattern</th>
              <th className="grid-th">Name</th>
              <th className="grid-th">Difficulty</th>
              <th className="grid-th">Score weight</th>
              <th className="grid-th">Removal price</th>
              <th className="grid-th">Relevant</th>
              <th className="grid-th">Vendor</th>
              <th className="grid-th"></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td className="grid-td font-mono text-xs">{r.pattern}</td>
                <td className="grid-td">{r.name}</td>
                <td className="grid-td">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      r.difficulty >= 8
                        ? 'bg-red-100 text-red-700'
                        : r.difficulty >= 5
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-green-100 text-green-700'
                    }`}
                  >
                    D{r.difficulty}
                  </span>
                </td>
                <td className="grid-td font-mono">{r.score_weight}</td>
                <td className="grid-td font-mono text-green-700">
                  ${Number(r.removal_price).toLocaleString()}
                </td>
                <td className="grid-td">{r.relevant ? '✓' : ''}</td>
                <td className="grid-td text-gray-500">{r.vendors?.name ?? ''}</td>
                <td className="grid-td">
                  <button className="btn py-0.5 text-xs" onClick={() => setForm(r)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
            {rules.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-sm text-gray-400">
                  No rules yet — add the sites you monitor (complaint boards, mugshot sites, news
                  outlets…).
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {form && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20" onClick={() => setForm(null)}>
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-3 text-sm font-semibold">{form.id ? 'Edit rule' : 'New rule'}</h2>
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-2">
                <label className="label">Domain / pattern</label>
                <input
                  className="input"
                  placeholder="mugshots.com"
                  value={form.pattern ?? ''}
                  onChange={(e) => setForm((f: any) => ({ ...f, pattern: e.target.value }))}
                />
              </div>
              <div className="col-span-2">
                <label className="label">Display name</label>
                <input
                  className="input"
                  value={form.name ?? ''}
                  onChange={(e) => setForm((f: any) => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div>
                <label className="label">Difficulty (1–10)</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={10}
                  value={form.difficulty ?? 5}
                  onChange={(e) => setForm((f: any) => ({ ...f, difficulty: e.target.value }))}
                />
              </div>
              <div>
                <label className="label">Score weight</label>
                <input
                  className="input"
                  type="number"
                  value={form.score_weight ?? 10}
                  onChange={(e) => setForm((f: any) => ({ ...f, score_weight: e.target.value }))}
                />
              </div>
              <div>
                <label className="label">Removal price ($)</label>
                <input
                  className="input"
                  type="number"
                  value={form.removal_price ?? 0}
                  onChange={(e) => setForm((f: any) => ({ ...f, removal_price: e.target.value }))}
                />
              </div>
              <div>
                <label className="label">Vendor</label>
                <select
                  className="input"
                  value={form.vendor_id ?? ''}
                  onChange={(e) => setForm((f: any) => ({ ...f, vendor_id: e.target.value }))}
                >
                  <option value="">—</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </div>
              <label className="col-span-2 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!form.relevant}
                  onChange={(e) => setForm((f: any) => ({ ...f, relevant: e.target.checked }))}
                />
                Relevant — keep results from this domain in the auto Google search
              </label>
              <div className="col-span-2 flex justify-between pt-1">
                {form.id ? (
                  <button
                    className="btn text-red-600"
                    onClick={async () => {
                      if (!confirm('Delete this rule?')) return;
                      await supabase.from('url_rules').delete().eq('id', form.id);
                      setForm(null);
                      load();
                    }}
                  >
                    Delete
                  </button>
                ) : (
                  <span />
                )}
                <div className="flex gap-2">
                  <button className="btn" onClick={() => setForm(null)}>
                    Cancel
                  </button>
                  <button className="btn btn-primary" onClick={save}>
                    Save
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
