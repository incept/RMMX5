'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Lightweight rich-text editor for email compose + templates.
 *
 * Built on `contentEditable` + `document.execCommand` rather than a heavy
 * WYSIWYG dependency: the output must be simple, inline-styled, email-client-
 * safe HTML, and this project keeps its dependency surface small. execCommand is
 * deprecated but universally supported and a good fit for this constrained use.
 *
 * The HTML this produces is stored and later mailed out; pasted content is
 * scrubbed on the way in, and the compose/template save paths run it through
 * `sanitizeEmailHtml` as well. CRM rendering happens inside a sandboxed iframe.
 */

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll('"', '&quot;');
}

// Does the HTML carry anything visible? Used to toggle the placeholder without a
// controlled-value round-trip fighting the caret.
function hasContent(html: string): boolean {
  if (/<(img|hr|table|blockquote)\b/i.test(html)) return true;
  const text = html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .trim();
  return text.length > 0;
}

export interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeight?: number;
  /** When provided, an "upload image" button appears; returns the hosted URL. */
  onImageUpload?: (file: File) => Promise<string>;
}

export default function RichTextEditor({
  value,
  onChange,
  placeholder = 'Write your message…',
  minHeight = 180,
  onImageUpload,
}: RichTextEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // What we last pushed up via onChange. Lets us tell an external `value` change
  // (template insert, reset-after-send) from our own edits, so we only rewrite
  // innerHTML — and jump the caret — for genuinely external changes.
  const lastEmitted = useRef<string>('');
  const savedRange = useRef<Range | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (value !== lastEmitted.current) {
      el.innerHTML = value || '';
      lastEmitted.current = value || '';
    }
  }, [value]);

  const emit = useCallback(() => {
    const html = ref.current?.innerHTML ?? '';
    lastEmitted.current = html;
    onChange(html);
  }, [onChange]);

  // Remember the caret/selection while it's inside the editor, so a toolbar
  // action that steals focus (a file dialog, window.prompt) can restore it.
  const saveSelection = useCallback(() => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && ref.current?.contains(sel.anchorNode)) {
      savedRange.current = sel.getRangeAt(0).cloneRange();
    }
  }, []);

  const restoreSelection = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (savedRange.current && sel) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
  }, []);

  const exec = useCallback(
    // Toolbar buttons keep the editor's live selection (mousedown-preventDefault),
    // so they must NOT restore a saved range — a snapshot taken before a prior
    // command detaches once that command mutates the DOM. Controls that steal
    // focus (the style <select>, the color <input>) pass restore=true instead.
    (command: string, arg?: string, restore = false) => {
      if (restore) restoreSelection();
      if (command === 'foreColor' || command === 'hiliteColor') {
        document.execCommand('styleWithCSS', false, 'true');
      }
      document.execCommand(command, false, arg);
      emit();
    },
    [emit, restoreSelection]
  );

  const insertHtml = useCallback(
    (html: string) => {
      restoreSelection();
      document.execCommand('insertHTML', false, html);
      emit();
    },
    [emit, restoreSelection]
  );

  const addLink = useCallback(() => {
    saveSelection();
    const input = window.prompt('Link URL', 'https://');
    if (!input) return;
    const url = /^(https?:|mailto:)/i.test(input) ? input : `https://${input}`;
    const sel = window.getSelection();
    const selectedText = sel && !sel.isCollapsed ? sel.toString() : '';
    const text = selectedText || url;
    insertHtml(
      `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`
    );
  }, [insertHtml, saveSelection]);

  const addImageByUrl = useCallback(() => {
    saveSelection();
    const input = window.prompt('Image URL (https://…)', 'https://');
    if (!input || !/^https?:\/\//i.test(input)) return;
    insertHtml(`<img src="${escapeAttr(input)}" alt="" style="max-width:100%;height:auto"/>`);
  }, [insertHtml, saveSelection]);

  const onFilePicked = useCallback(
    async (file: File | null) => {
      if (!file || !onImageUpload) return;
      setUploading(true);
      try {
        const url = await onImageUpload(file);
        if (url) {
          insertHtml(`<img src="${escapeAttr(url)}" alt="" style="max-width:100%;height:auto"/>`);
        }
      } catch (error: any) {
        alert(error?.message || 'Image upload failed');
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    },
    [insertHtml, onImageUpload]
  );

  // Paste as scrubbed HTML (keep basic formatting from the web / Word) or plain
  // text — never raw clipboard HTML, which can carry scripts and event handlers.
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      e.preventDefault();
      const html = e.clipboardData.getData('text/html');
      if (html) {
        insertHtml(scrubPastedHtml(html));
      } else {
        const text = e.clipboardData.getData('text/plain');
        insertHtml(escapeHtml(text).replace(/\r?\n/g, '<br/>'));
      }
    },
    [insertHtml]
  );

  const showPlaceholder = !hasContent(value);

  return (
    <div className="overflow-hidden rounded-lg border border-gray-300 bg-surface focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-gray-200 p-1">
        <TB label="Bold" onClick={() => exec('bold')}>
          <span className="font-bold">B</span>
        </TB>
        <TB label="Italic" onClick={() => exec('italic')}>
          <span className="italic">I</span>
        </TB>
        <TB label="Underline" onClick={() => exec('underline')}>
          <span className="underline">U</span>
        </TB>
        <TB label="Strikethrough" onClick={() => exec('strikeThrough')}>
          <span className="line-through">S</span>
        </TB>
        <Divider />
        <select
          className="h-7 rounded border border-gray-300 bg-surface px-1 text-xs text-gray-700"
          title="Paragraph style"
          value=""
          onMouseDown={saveSelection}
          onChange={(e) => {
            if (e.target.value) exec('formatBlock', e.target.value, true);
            e.currentTarget.value = '';
          }}
        >
          <option value="">Style</option>
          <option value="p">Normal</option>
          <option value="h2">Heading</option>
          <option value="h3">Subheading</option>
          <option value="blockquote">Quote</option>
        </select>
        <label
          className="flex h-7 cursor-pointer items-center gap-1 rounded px-1.5 text-xs text-gray-700 hover:bg-gray-100"
          title="Text color"
          onMouseDown={saveSelection}
        >
          <span className="font-semibold underline decoration-2">A</span>
          <input
            type="color"
            className="h-4 w-4 cursor-pointer border-0 bg-transparent p-0"
            onChange={(e) => exec('foreColor', e.target.value, true)}
          />
        </label>
        <Divider />
        <TB label="Bulleted list" onClick={() => exec('insertUnorderedList')}>
          <ListIcon ordered={false} />
        </TB>
        <TB label="Numbered list" onClick={() => exec('insertOrderedList')}>
          <ListIcon ordered />
        </TB>
        <Divider />
        <TB label="Insert link" onClick={addLink}>
          <LinkIcon />
        </TB>
        {onImageUpload && (
          <TB label="Upload image" disabled={uploading} onClick={() => { saveSelection(); fileRef.current?.click(); }}>
            {uploading ? <span className="text-[10px]">…</span> : <ImageIcon />}
          </TB>
        )}
        <TB label="Image by URL" onClick={addImageByUrl}>
          <LinkImageIcon />
        </TB>
        <Divider />
        <TB label="Clear formatting" onClick={() => exec('removeFormat')}>
          <span className="text-xs">T×</span>
        </TB>
      </div>

      <div className="relative">
        {showPlaceholder && (
          <div className="pointer-events-none absolute left-3 top-2 text-sm text-gray-400">
            {placeholder}
          </div>
        )}
        <div
          ref={ref}
          className="rte-content overflow-auto px-3 py-2 text-sm text-gray-900 outline-none"
          style={{ minHeight, maxHeight: 420 }}
          contentEditable
          suppressContentEditableWarning
          onInput={emit}
          onBlur={() => { saveSelection(); emit(); }}
          onKeyUp={saveSelection}
          onMouseUp={saveSelection}
          onPaste={onPaste}
        />
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => onFilePicked(e.target.files?.[0] ?? null)}
      />
    </div>
  );
}

/** Scrub clipboard HTML down to safe formatting before it enters the document. */
function scrubPastedHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|meta|link|title|head|iframe|object|embed)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|src)\s*=\s*"(\s*javascript:[^"]*)"/gi, '$1="#"')
    .replace(/\sclass\s*=\s*"[^"]*"/gi, '')
    .replace(/<\/?(html|body|o:p)[^>]*>/gi, '');
}

function TB({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      // mousedown preventDefault keeps the editor's selection alive through the click
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-gray-700 hover:bg-gray-100 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-0.5 h-5 w-px bg-gray-200" aria-hidden />;
}

function ListIcon({ ordered }: { ordered: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="9" y1="6" x2="20" y2="6" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <line x1="9" y1="18" x2="20" y2="18" />
      {ordered ? (
        <text x="2" y="9" fontSize="7" fill="currentColor" stroke="none">1</text>
      ) : (
        <>
          <circle cx="4" cy="6" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="4" cy="12" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="4" cy="18" r="1.4" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

function LinkImageIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8" cy="10" r="1.4" />
      <path d="M21 16l-4-4L8 21" />
    </svg>
  );
}
