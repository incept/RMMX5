'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Admin: Deep Search Sites — the sites the deep search probes. Fully editable:
 * add a site, delete one, and tune its coverage, SERP fallback, render/browser
 * tier, priority, and — carefully — its URL templates.
 *
 * The URL templates (search / record / date) are the delicate part: a typo
 * silently stops a site from returning results, so the form spells out the
 * placeholders and warns before you touch them. The seeded sites still come from
 * the migrations; this page lets an admin adjust or extend them at runtime.
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

const BLANK_FORM = {
  id: null as string | null,
  domain: '',
  name: '',
  search_template: '',
  record_url_template: '',
  date_url_template: '',
  coverage: 'national',
  state: '',
  county: '',
  active: true,
  serp_fallback: false,
  needs_render: false,
  needs_browser: false,
  priority: 100 as number | string,
  family: '',
  notes: '',
};

export default function DeepSearchSitesPage() {
  const [sites, setSites] = useState<any[]>([]);
  const [form, setForm] = useState<any>(null);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const response = await fetch('/api/admin/probe-sites', { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Could not load probe sites');
      setSites(body.sites ?? []);
    } catch (error) {
      setSites([]);
      setLoadError(error instanceof Error ? error.message : 'Could not load probe sites');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openNew() {
    setForm({ ...BLANK_FORM });
  }

  // Translate a row's scope/scope_state/scope_county into the friendlier
  // "National vs state-specific + optional county" shape.
  function openEdit(site: any) {
    setForm({
      id: site.id,
      domain: site.domain ?? '',
      name: site.name ?? '',
      search_template: site.search_template ?? '',
      record_url_template: site.record_url_template ?? '',
      date_url_template: site.date_url_template ?? '',
      coverage: site.scope === 'national' || !site.scope_state ? 'national' : 'state',
      state: site.scope_state ?? '',
      county: site.scope_county ?? '',
      active: !!site.active,
      serp_fallback: !!site.serp_fallback,
      needs_render: !!site.needs_render,
      needs_browser: !!site.needs_browser,
      priority: site.priority ?? 100,
      family: site.family ?? '',
      notes: site.notes ?? '',
    });
  }

  const setField = (patch: Record<string, any>) => setForm((f: any) => ({ ...f, ...patch }));

  async function save() {
    const f = form;
    const national = f.coverage === 'national';
    const state = String(f.state ?? '').trim().toUpperCase();
    const county = String(f.county ?? '').trim();

    // Quick client-side checks; the API re-validates everything authoritatively.
    if (!f.domain?.trim()) return alert('A domain is required (e.g. arrests.org).');
    if (!/^https?:\/\//i.test(String(f.search_template ?? '').trim())) {
      return alert('The search URL template must be a full http(s) URL.');
    }
    if (!national && !STATE_CODES.has(state)) {
      return alert('Pick a state for a state-specific site.');
    }
    const priority = Number(f.priority);
    if (!Number.isInteger(priority) || priority < 1 || priority > 1000) {
      return alert('Priority must be a whole number from 1 (highest) to 1000.');
    }

    const payload = {
      ...(f.id ? { id: f.id } : {}),
      domain: f.domain,
      name: f.name,
      search_template: f.search_template,
      record_url_template: f.record_url_template,
      date_url_template: f.date_url_template,
      scope: national ? 'national' : county ? 'county' : 'state',
      scope_state: national ? null : state,
      scope_county: national ? null : county || null,
      active: !!f.active,
      serp_fallback: !!f.serp_fallback,
      needs_render: !!f.needs_render,
      needs_browser: !!f.needs_browser,
      priority,
      family: f.family,
      notes: f.notes,
    };

    setSaving(true);
    try {
      const response = await fetch('/api/admin/probe-sites', {
        method: f.id ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Could not save probe site');
      setForm(null);
      await load();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not save probe site');
    } finally {
      setSaving(false);
    }
  }

  async function remove(site: any) {
    if (
      !confirm(
        `Delete ${site.domain}?\n\nThe deep search will stop probing it. This cannot be undone.`
      )
    ) {
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/admin/probe-sites?id=${encodeURIComponent(site.id)}`, {
        method: 'DELETE',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Could not delete probe site');
      setForm(null);
      await load();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not delete probe site');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-2xl font-light tracking-tight">Deep Search Sites</h1>
        <button className="btn btn-primary" onClick={openNew}>
          + Add site
        </button>
      </div>
      <p className="mb-4 max-w-3xl text-xs text-gray-400">
        The sites the deep search probes, and the coverage that decides which contacts each runs
        for. A <strong>national</strong> site runs for everyone; a <strong>state-specific</strong>{' '}
        site (optionally narrowed to a county) runs only for a contact placed in that state — so an
        NC roster is never searched for a Georgia lead, and no billable request is spent on it.
        Lower priority number = tried first.
      </p>

      {loadError && (
        <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError}
        </div>
      )}

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
                  No probe sites yet. Add one, or they are seeded by the deep-search migrations.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {form && (
        <div
          className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/20 p-6"
          onClick={() => setForm(null)}
        >
          <div
            className="w-full max-w-lg rounded-xl bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-3 text-sm font-semibold">{form.id ? 'Edit site' : 'Add site'}</h2>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="label">Domain</label>
                  <input
                    className="input font-mono text-xs"
                    placeholder="arrests.org"
                    value={form.domain}
                    onChange={(e) => setField({ domain: e.target.value })}
                  />
                </div>
                <div>
                  <label className="label">Name</label>
                  <input
                    className="input"
                    placeholder="Arrests.org"
                    value={form.name}
                    onChange={(e) => setField({ name: e.target.value })}
                  />
                </div>
              </div>

              <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                URL templates are delicate — a typo silently stops the site from returning results.
                Placeholders:{' '}
                <code className="font-mono">
                  {'{name} {first} {middle} {last} {county} {county_slug} {state} {state_lower} {state_name} {from_date} {to_date}'}
                </code>{' '}
                (record URL uses <code className="font-mono">{'{record_id}'}</code>). They&apos;re
                URL-encoded on substitution.
              </div>

              <div>
                <label className="label">Search URL template</label>
                <input
                  className="input font-mono text-xs"
                  placeholder="https://arrests.org/?s={name}"
                  value={form.search_template}
                  onChange={(e) => setField({ search_template: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="label">Record URL template (optional)</label>
                  <input
                    className="input font-mono text-xs"
                    placeholder="https://…/{record_id}"
                    value={form.record_url_template}
                    onChange={(e) => setField({ record_url_template: e.target.value })}
                  />
                </div>
                <div>
                  <label className="label">Date URL template (optional)</label>
                  <input
                    className="input font-mono text-xs"
                    placeholder="https://…/{from_date}"
                    value={form.date_url_template}
                    onChange={(e) => setField({ date_url_template: e.target.value })}
                  />
                </div>
              </div>

              <div>
                <label className="label">Coverage</label>
                <select
                  className="input"
                  value={form.coverage}
                  onChange={(e) => setField({ coverage: e.target.value })}
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
                      onChange={(e) => setField({ state: e.target.value })}
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
                      onChange={(e) => setField({ county: e.target.value })}
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="label">Priority (1 = highest)</label>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={1000}
                    value={form.priority}
                    onChange={(e) => setField({ priority: e.target.value })}
                  />
                </div>
                <div>
                  <label className="label">Family (optional)</label>
                  <input
                    className="input"
                    placeholder="sibling network"
                    value={form.family}
                    onChange={(e) => setField({ family: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!form.active}
                    onChange={(e) => setField({ active: e.target.checked })}
                  />
                  Active (probe directly)
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!form.serp_fallback}
                    onChange={(e) => setField({ serp_fallback: e.target.checked })}
                  />
                  SERP fallback
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!form.needs_render}
                    onChange={(e) => setField({ needs_render: e.target.checked })}
                  />
                  Needs render (JS)
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!form.needs_browser}
                    onChange={(e) => setField({ needs_browser: e.target.checked })}
                  />
                  Needs browser
                </label>
              </div>

              <div>
                <label className="label">Notes (optional)</label>
                <textarea
                  className="input min-h-16 text-sm"
                  placeholder="Anything worth remembering about this site."
                  value={form.notes}
                  onChange={(e) => setField({ notes: e.target.value })}
                />
              </div>

              <div className="flex items-center justify-between pt-1">
                {form.id ? (
                  <button
                    className="btn text-red-600"
                    disabled={saving}
                    onClick={() => remove(form)}
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
                  <button className="btn btn-primary" onClick={save} disabled={saving}>
                    {saving ? 'Saving…' : form.id ? 'Save' : 'Add site'}
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
