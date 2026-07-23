'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

const TAB_OPTIONS = [
  { value: 'contact', label: 'Contact Info' },
  { value: 'link', label: 'Link Data' },
  { value: 'email', label: 'Email' },
  { value: 'data', label: 'Data' },
];

/** Admin: custom fields shown on the contact panel, per tab. */
export default function CustomFieldsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [fields, setFields] = useState<any[]>([]);
  const [form, setForm] = useState<any>(null);

  const load = useCallback(async () => {
    const { data } = await supabase.from('custom_fields').select('*').order('sort_order');
    setFields(data ?? []);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    const f = form;
    if (!f.label) return alert('Label required');
    const fieldKey =
      f.field_key || f.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const row = {
      tab: f.tab ?? 'contact',
      label: f.label,
      field_key: fieldKey,
      field_type: f.field_type ?? 'text',
      options:
        f.field_type === 'select'
          ? String(f.optionsText ?? '')
              .split(',')
              .map((s: string) => s.trim())
              .filter(Boolean)
          : [],
      sort_order: Number(f.sort_order ?? fields.length + 1),
    };
    const { error } = f.id
      ? await supabase.from('custom_fields').update(row).eq('id', f.id)
      : await supabase.from('custom_fields').insert(row);
    if (error) return alert(error.message);
    setForm(null);
    load();
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Custom Fields</h1>
        <button className="btn btn-primary" onClick={() => setForm({ tab: 'contact', field_type: 'text' })}>
          + Add field
        </button>
      </div>
      <p className="mb-4 text-xs text-gray-400">
        Custom fields appear on the contact panel under their tab. Values are stored per contact
        and can be used as {'{{placeholders}}'} in email templates (by field key).
      </p>

      {TAB_OPTIONS.map((tabOption) => {
        const tabFields = fields.filter((f) => f.tab === tabOption.value);
        if (!tabFields.length) return null;
        return (
          <div key={tabOption.value} className="card mb-3">
            <h2 className="mb-2 text-sm font-semibold">{tabOption.label} tab</h2>
            {tabFields.map((f) => (
              <div key={f.id} className="mb-1 flex items-center gap-3 text-sm">
                <span className="flex-1 font-medium">{f.label}</span>
                <code className="text-xs text-gray-400">{`{{${f.field_key}}}`}</code>
                <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                  {f.field_type}
                </span>
                <button className="btn py-0.5 text-xs" onClick={() => setForm({ ...f, optionsText: (f.options ?? []).join(', ') })}>
                  Edit
                </button>
                <button
                  className="text-xs text-gray-400 hover:text-red-600"
                  onClick={async () => {
                    if (!confirm(`Delete field "${f.label}"?`)) return;
                    await supabase.from('custom_fields').delete().eq('id', f.id);
                    load();
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        );
      })}
      {fields.length === 0 && (
        <div className="py-12 text-center text-sm text-gray-400">No custom fields yet.</div>
      )}

      {form && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20" onClick={() => setForm(null)}>
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-3 text-sm font-semibold">{form.id ? 'Edit field' : 'New field'}</h2>
            <div className="space-y-2">
              <div>
                <label className="label">Label</label>
                <input
                  className="input"
                  value={form.label ?? ''}
                  onChange={(e) => setForm((f: any) => ({ ...f, label: e.target.value }))}
                />
              </div>
              <div>
                <label className="label">Tab</label>
                <select
                  className="input"
                  value={form.tab}
                  onChange={(e) => setForm((f: any) => ({ ...f, tab: e.target.value }))}
                >
                  {TAB_OPTIONS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Type</label>
                <select
                  className="input"
                  value={form.field_type}
                  onChange={(e) => setForm((f: any) => ({ ...f, field_type: e.target.value }))}
                >
                  <option value="text">Text</option>
                  <option value="number">Number</option>
                  <option value="date">Date</option>
                  <option value="select">Select</option>
                </select>
              </div>
              {form.field_type === 'select' && (
                <div>
                  <label className="label">Options (comma-separated)</label>
                  <input
                    className="input"
                    value={form.optionsText ?? ''}
                    onChange={(e) => setForm((f: any) => ({ ...f, optionsText: e.target.value }))}
                  />
                </div>
              )}
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
