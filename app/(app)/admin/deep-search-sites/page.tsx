'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

/**
 * Admin: Deep Search Sites — the sites the deep search actually probes, and the
 * one thing about them worth tuning by hand: their COVERAGE. A site marked for a
 * state (or a county within it) runs only for a contact we can place there; a
 * national site runs for everyone. This is the config side of the engine's
 * state scoping — set it here, and the Deep Run honours it.
 *
 * Deliberately NOT a full site editor. The URL templates (search/record/date)
 * are delicate — a typo silently stops a site from returning results — so they
 * stay in the migrations. This page edits only the safe knobs.
 */

// Inlined so the page carries no server-side dependency.
const US_STATES: { code: string; name: string }[] = [
  { code: 'AL', name: 'Alabama' }, { code: 'AK', name: 'Alaska' }, { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' }, { code: 'CA', name: 'California' }, { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' }, { code: 'DE', name: 'Delaware' }, { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' }, { code: 'GA', name: 'Georgia' }, { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' }, { code: 'IL', name: 'Illinois' }, { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' }, { code: 'KS', name: 'Kansas' }, { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' }, { code: 'ME', name: 'Maine' }, { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' }, { code: 'MI', name: 'Michigan' }, { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' }, { code: 'MO', name: 'Missouri' }, { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' }, { code: 'NV', name: 'Nevada' }, { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' }, { code: 'NM', name: 'New Mexico' }, { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' }, { code: 'ND', name: 'North Dakota' }, { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' }, { code: 'OR', name: 'Oregon' }, { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' }, { code: 'SC', name: 'South Carolina' }, { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' }, { code: 'TX', name: 'Texas' }, { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' }, { code: 'VA', name: 'Virginia' }, { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' }, { code: 'WI', name: 'Wisconsin' }, { code: 'WY', name: 'Wyoming' },
];
const STATE_CODES = new Set(US_STATES.map((s) => s.code));

function coverageLabel(site: any): string {
  if (site.scope === 'national' || !site.scope_state) return 'National';
  if (site.scope === 'county' && site.scope_county) return `${site.scope_county}, ${site.scope_state}`;
  return site.scope_state;
}

export default function DeepSearchSitesPage() {
  const supabase = useMemo(() => createClient(), []);
  const [sites, setSites] = useState<any[]>([]);
  const [form, setForm] = useState<any>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('probe_sites')
      .select('*')
      .order('scope')
      .order('priority')
      .order('domain');
    setSites(data ?? []);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  // Open the edit modal, translating the row's scope/scope_state/scope_county
  // into the friendlier "National vs state-specific + optional county" shape.
  function openEdit(site: any) {
    setForm({
      id: site.id,
      domain: site.domain,
      name: site.name,
      coverage: site.scope === 'national' || !site.scope_state ? 'national' : 'state',
      state: site.scope_state ?? '',
      county: site.scope_county ?? '',
      active: !!site.active,
      serp_fallback: !!site.serp_fallback,
      priority: site.priority ?? 100,
    });
  }

  async function save() {
    const f = form;
    const national = f.coverage === 'national';
    const state = String(f.state ?? '').trim().toUpperCase();
    const county = String(f.county ?? '').trim();

    if (!national && !STATE_CODES.has(state)) {
      return alert('Pick a state for a state-specific site.');
    }
    const priority = Number(f.priority);
    if (!Number.isInteger(priority) || priority < 1 || priority > 1000) {
      return alert('Priority must be a whole number from 1 (highest) to 1000.');
    }

    // Coverage → the three scope columns. A county implies scope 'county'; a
    // state alone is scope 'state'; national clears both.
    const row = {
      active: !!f.active,
      serp_fallback: !!f.serp_fallback,
      priority,
      scope: national ? 'national' : county ? 'county' : 'state',
      scope_state: national ? null : state,
      scope_county: national ? null : county || null,
    };
    const { error } = await supabase.from('probe_sites').update(row).eq('id', f.id);
    if (error) return alert(error.message);
    setForm(null);
    load();
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-2xl font-light tracking-tight">Deep Search Sites</h1>
      </div>
      <p className="mb-4 max-w-3xl text-xs text-gray-400">
        The sites the deep search probes, and the coverage that decides which contacts each runs
        for. A <strong>national</strong> site runs for everyone; a <strong>state-specific</strong>{' '}
        site (optionally narrowed to a county) runs only for a contact placed in that state — so an
        NC roster is never searched for a Georgia lead, and no billable request is spent on it.
        Lower priority number = tried first. URL templates are managed in migrations and aren&apos;t
        shown here.
      </p>

      <div className="card p-0">
        <table className="w-full">
          <thead>
            <tr>
              <th className="grid-th">Domain</th>
              <th className="grid-th">Name</th>
              <th className="grid-th">Coverage</th>
              <th className="grid-th">Active</th>
              <th className="grid-th">SERP fallback</th>
              <th className="grid-th">Priority</th>
              <th className="grid-th"></th>
            </tr>
          </thead>
          <tbody>
            {sites.map((s) => (
              <tr key={s.id} className={s.active ? '' : 'opacity-50'}>
                <td className="grid-td font-mono text-xs">{s.domain}</td>
                <td className="grid-td">{s.name}</td>
                <td className="grid-td">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      s.scope === 'national' || !s.scope_state
                        ? 'bg-gray-100 text-gray-600'
                        : 'bg-brand-50 text-brand-700'
                    }`}
                  >
                    {coverageLabel(s)}
                  </span>
                </td>
                <td className="grid-td">{s.active ? '✓' : ''}</td>
                <td className="grid-td">{s.serp_fallback ? '✓' : ''}</td>
                <td className="grid-td font-mono">{s.priority}</td>
                <td className="grid-td">
                  <button className="btn py-0.5 text-xs" onClick={() => openEdit(s)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
            {sites.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-sm text-gray-400">
                  No probe sites found. They are seeded by the deep-search migrations.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {form && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/20"
          onClick={() => setForm(null)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-1 text-sm font-semibold">Edit site coverage</h2>
            <p className="mb-3 font-mono text-xs text-gray-500">{form.domain}</p>

            <div className="space-y-3">
              <div>
                <label className="label">Coverage</label>
                <select
                  className="input"
                  value={form.coverage}
                  onChange={(e) => setForm((f: any) => ({ ...f, coverage: e.target.value }))}
                >
                  <option value="national">National — runs for every contact</option>
                  <option value="state">State-specific — runs only for that state</option>
                </select>
              </div>

              {form.coverage === 'state' && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="label">State</label>
                    <select
                      className="input"
                      value={form.state}
                      onChange={(e) => setForm((f: any) => ({ ...f, state: e.target.value }))}
                    >
                      <option value="">— pick —</option>
                      {US_STATES.map((st) => (
                        <option key={st.code} value={st.code}>
                          {st.code} — {st.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label">County (optional)</label>
                    <input
                      className="input"
                      placeholder="e.g. Fulton"
                      value={form.county}
                      onChange={(e) => setForm((f: any) => ({ ...f, county: e.target.value }))}
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!form.active}
                    onChange={(e) => setForm((f: any) => ({ ...f, active: e.target.checked }))}
                  />
                  Active (probe directly)
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!form.serp_fallback}
                    onChange={(e) => setForm((f: any) => ({ ...f, serp_fallback: e.target.checked }))}
                  />
                  SERP fallback
                </label>
              </div>

              <div>
                <label className="label">Priority (1 = highest)</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={1000}
                  value={form.priority}
                  onChange={(e) => setForm((f: any) => ({ ...f, priority: e.target.value }))}
                />
              </div>

              <div className="flex justify-end gap-2 pt-1">
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
      )}
    </div>
  );
}
