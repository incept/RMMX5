'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import RichTextEditor from '@/components/RichTextEditor';
import { uploadEmailImage } from '@/lib/email-image-upload';
import { LINK_PLACEHOLDERS } from '@/lib/template-placeholders';

/**
 * Compose one email to a set of selected contacts. Placeholders ({{name}},
 * {{city}}, {{link1}}…) are left raw and resolved per recipient by the send
 * route, so a template is inserted verbatim. One stable idempotency key per
 * composer keeps a double-click from double-sending.
 */
export default function BulkEmailComposer({
  contactIds,
  onClose,
  onSent,
}: {
  contactIds: string[];
  onClose: () => void;
  onSent: (message: string) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [accounts, setAccounts] = useState<{ id: string; name: string; from_email: string }[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [accountId, setAccountId] = useState('');
  const [subject, setSubject] = useState('');
  const [html, setHtml] = useState('');
  const [busy, setBusy] = useState(false);
  const [requestKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    supabase
      .from('email_accounts_safe')
      .select('id, name, from_email')
      .order('name')
      .then(({ data }) => setAccounts(data ?? []));
    supabase
      .from('email_templates')
      .select('id, name, subject, html')
      .order('name')
      .then(({ data }) => setTemplates(data ?? []));
  }, [supabase]);

  function applyTemplate(id: string) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setSubject((s) => t.subject || s);
    setHtml(t.html ?? '');
  }

  async function send() {
    if (!subject.trim() || !html.trim()) return alert('Subject and body are required');
    setBusy(true);
    const res = await fetch('/api/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestKey },
      body: JSON.stringify({ contactIds, subject, html, accountId: accountId || null }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      const n = data.queued ?? contactIds.length;
      onSent(
        `Queued ${n} email${n === 1 ? '' : 's'}` +
          (data.skipped ? ` (${data.skipped} had no email)` : '')
      );
      onClose();
    } else {
      alert(data.error ?? 'Send failed');
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/20 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold">
          Email {contactIds.length} selected contact{contactIds.length === 1 ? '' : 's'}
        </h2>
        <p className="mb-3 text-xs text-gray-400">
          Placeholders like {`{{name}}`}, {`{{city}}`} and {`{{link1}}`} are filled in per recipient.
        </p>
        <div className="space-y-2">
          {accounts.length > 0 && (
            <select
              className="input"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">Default account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.from_email})
                </option>
              ))}
            </select>
          )}
          <input
            className="input"
            placeholder="Subject — {{name}}, {{city}} work"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
          {templates.length > 0 && (
            <select
              className="input"
              value=""
              onChange={(e) => {
                if (e.target.value) applyTemplate(e.target.value);
                e.currentTarget.value = '';
              }}
            >
              <option value="">Insert template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
          <RichTextEditor
            value={html}
            onChange={setHtml}
            onImageUpload={uploadEmailImage}
            linkPlaceholders={LINK_PLACEHOLDERS}
            minHeight={200}
            placeholder="Message… placeholders are filled per recipient when sent"
          />
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={send}>
              {busy ? 'Sending…' : `Send to ${contactIds.length}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
