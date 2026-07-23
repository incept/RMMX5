'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

/** Vendor management: cost, website, service page, and which sites they can remove. */
export default function VendorsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [vendors, setVendors] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [form, setForm] = useState<any>(null);

  const load = useCallback(async () => {
    const [{ data: vendorRows }, { data: ruleRows }] = await Promise.all([
      supabase.from('vendors').select('*, vendor_capabilities ( id, url_rule_id, cost )').order('name'),
      supabase.from('url_rules').select('id, pattern, name').order('pattern'),
    ]);
    setVendors(vendorRows ?? []);
    setRules(ruleRows ?? []);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveVendor() {
    const row = {
      name: form.name,
      website: form.website || null,
      service_page_url: form.service_page_url || null,
      base_cost: form.base_cost ? Number(form.base_cost) : null,
      notes: form.notes || null,
    };
    if (!row.name) return alert('Name required');
    const { error } = form.id
      ? await supabase.from('vendors').update(row).eq('id', form.id)
      : await supabase.from('vendors').insert(row);
    if (error) return alert(error.message + ' (admin only)');
    setForm(null);
    load();
  }

  async function toggleCapability(vendor: any, ruleId: string) {
    const existing = vendor.vendor_capabilities?.find((c: any) => c.url_rule_id === ruleId);
    if (existing) await supabase.from('vendor_capabilities').delete().eq('id', existing.id);
    else await supabase.from('vendor_capabilities').insert({ vendor_id: vendor.id, url_rule_id: ruleId });
    load();
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Vendors</h1>
        <button className="btn btn-primary" onClick={() => setForm({})}>
          + Add vendor
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {vendors.map((v) => (
          <div key={v.id} className="card">
            <div className="flex items-start justify-between">
              <div>
                <div className="font-semibold">{v.name}</div>
                {v.website && (
                  <a href={v.website} target="_blank" rel="noreferrer" className="text-xs text-brand-600 hover:underline">
                    {v.website}
                  </a>
                )}
              </div>
              <div className="flex items-center gap-2">
                {v.base_cost != null && (
                  <span className="font-mono text-sm text-green-700">${Number(v.base_cost).toLocaleString()}</span>
                )}
                <button className="btn py-1" onClick={() => setForm(v)}>
                  Edit
                </button>
              </div>
            </div>
            {v.service_page_url && (
              <div className="mt-1 text-xs text-gray-500">
                Service page:{' '}
                <a href={v.service_page_url} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">
                  {v.service_page_url}
                </a>
              </div>
            )}
            {v.notes && <div className="mt-1 text-xs text-gray-500">{v.notes}</div>}
            <div className="mt-3">
              <div className="label">Can remove</div>
              <div className="flex flex-wrap gap-1.5">
                {rules.map((r) => {
                  const has = v.vendor_capabilities?.some((c: any) => c.url_rule_id === r.id);
                  return (
                    <button
                      key={r.id}
                      onClick={() => toggleCapability(v, r.id)}
                      className={`rounded-full px-2.5 py-0.5 text-xs transition-colors ${
                        has
                          ? 'bg-brand-600 text-white'
                          : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                      }`}
                    >
                      {r.name || r.pattern}
                    </button>
                  );
                })}
                {rules.length === 0 && (
                  <span className="text-xs text-gray-400">
                    Define sites under Admin → URL Rules first.
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
        {vendors.length === 0 && (
          <div className="col-span-2 py-12 text-center text-sm text-gray-400">No vendors yet.</div>
        )}
      </div>

      {form && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20" onClick={() => setForm(null)}>
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-3 text-sm font-semibold">{form.id ? 'Edit vendor' : 'New vendor'}</h2>
            <div className="space-y-2">
              {[
                ['name', 'Name'],
                ['website', 'Website'],
                ['service_page_url', 'Service page URL'],
                ['base_cost', 'Base cost ($)'],
                ['notes', 'Notes'],
              ].map(([key, label]) => (
                <div key={key}>
                  <label className="label">{label}</label>
                  <input
                    className="input"
                    value={form[key] ?? ''}
                    onChange={(e) => setForm((f: any) => ({ ...f, [key]: e.target.value }))}
                  />
                </div>
              ))}
              <div className="flex justify-between pt-1">
                {form.id ? (
                  <button
                    className="btn text-red-600"
                    onClick={async () => {
                      if (!confirm('Delete this vendor?')) return;
                      await supabase.from('vendors').delete().eq('id', form.id);
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
                  <button className="btn btn-primary" onClick={saveVendor}>
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
