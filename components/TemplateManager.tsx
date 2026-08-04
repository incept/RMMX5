'use client';

import { useState } from 'react';
import TemplateEditorModal, { type TemplateDraft } from '@/components/TemplateEditorModal';

/**
 * A grid of email templates with New / Edit (delete lives in the editor). The
 * host owns the template list and passes onChanged to refetch after a save or
 * delete. Rendered inline in the Email Marketing hub and inside a modal on the
 * inbox, so both surfaces manage templates identically.
 */
export default function TemplateManager({
  templates,
  onChanged,
}: {
  templates: any[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<TemplateDraft | null>(null);

  return (
    <div>
      <button
        className="btn btn-primary mb-4"
        onClick={() => setEditing({ name: '', subject: '', html: '' })}
      >
        + New template
      </button>
      {templates.length === 0 && (
        <div className="mb-3 text-sm text-gray-400">
          No templates yet. Create one to reuse it in the composer.
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-3">
        {templates.map((t) => (
          <div key={t.id} className="card">
            <div className="font-semibold">{t.name}</div>
            <div className="mt-1 truncate text-xs text-gray-500">{t.subject}</div>
            <div className="mt-2 line-clamp-3 text-xs text-gray-400">
              {(t.html ?? '').replace(/<[^>]+>/g, ' ')}
            </div>
            <button className="btn mt-3 py-1" onClick={() => setEditing(t)}>
              Edit
            </button>
          </div>
        ))}
      </div>
      {editing && (
        <TemplateEditorModal
          template={editing}
          onClose={() => setEditing(null)}
          onSaved={onChanged}
        />
      )}
    </div>
  );
}
