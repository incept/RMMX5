'use client';

import { useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import RichTextEditor, { type LinkPlaceholder } from '@/components/RichTextEditor';
import { uploadEmailImage } from '@/lib/email-image-upload';
import { sanitizeEmailHtml } from '@/lib/html-sanitize';
import { LINK_PLACEHOLDERS } from '@/lib/template-placeholders';

export interface TemplateDraft {
  id?: string;
  name?: string;
  subject?: string;
  html?: string;
}

/**
 * Create / edit / delete one email template. Self-contained: it owns the
 * Supabase writes and the on-save HTML sanitize, so a host just hands it a draft
 * and an onSaved callback to refresh its list. Shared by the Email Marketing hub
 * and the inbox so template editing is identical in both places.
 */
export default function TemplateEditorModal({
  template,
  linkPlaceholders = LINK_PLACEHOLDERS,
  onClose,
  onSaved,
}: {
  template: TemplateDraft;
  linkPlaceholders?: LinkPlaceholder[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [form, setForm] = useState<TemplateDraft>(template);
  // Existing table / scaffolded HTML would be normalized by the rich editor's
  // contentEditable — open those in source mode instead.
  const [source, setSource] = useState(/<(table|html|style)\b|<!doctype/i.test(template.html || ''));
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!form.name) return alert('Name required');
    setBusy(true);
    const row = {
      name: form.name,
      subject: form.subject ?? '',
      html: sanitizeEmailHtml(form.html ?? ''),
    };
    const { error } = form.id
      ? await supabase.from('email_templates').update(row).eq('id', form.id)
      : await supabase.from('email_templates').insert(row);
    setBusy(false);
    if (error) return alert(error.message);
    onSaved();
    onClose();
  }

  async function remove() {
    if (!form.id) return;
    if (!confirm('Delete this template?')) return;
    setBusy(true);
    const { error } = await supabase.from('email_templates').delete().eq('id', form.id);
    setBusy(false);
    if (error) return alert(error.message);
    onSaved();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-sm font-semibold">{form.id ? 'Edit template' : 'New template'}</h2>
        <div className="space-y-2">
          <input
            className="input"
            placeholder="Template name"
            value={form.name ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <input
            className="input"
            placeholder="Subject — {{name}}, {{city}} placeholders work"
            value={form.subject ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
          />
          <div className="flex items-center justify-between">
            <span className="label mb-0">Body — {`{{name}}, {{city}}, {{state}}`} and custom keys</span>
            <button
              type="button"
              className="text-xs font-medium text-brand-700 hover:underline"
              onClick={() => setSource((s) => !s)}
            >
              {source ? 'Rich editor' : 'HTML source'}
            </button>
          </div>
          {source ? (
            <textarea
              className="input min-h-48 font-mono text-xs"
              placeholder="HTML body… use {{name}}, {{city}}, {{state}} and custom-field keys"
              value={form.html ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, html: e.target.value }))}
            />
          ) : (
            <RichTextEditor
              value={form.html ?? ''}
              onChange={(html) => setForm((f) => ({ ...f, html }))}
              onImageUpload={uploadEmailImage}
              linkPlaceholders={linkPlaceholders}
              minHeight={220}
              placeholder="Compose your template… placeholders like {{name}} are filled per contact when sent"
            />
          )}
          <div className="flex justify-between">
            {form.id ? (
              <button className="btn text-red-600" disabled={busy} onClick={remove}>
                Delete
              </button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={save}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
