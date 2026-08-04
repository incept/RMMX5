import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('the template editor is a shared component that writes and sanitizes', async () => {
  const editor = await read('../components/TemplateEditorModal.tsx');
  // Owns the create / update / delete against email_templates.
  assert.match(editor, /from\('email_templates'\)\.update\(row\)/);
  assert.match(editor, /from\('email_templates'\)\.insert\(row\)/);
  assert.match(editor, /from\('email_templates'\)\.delete\(\)\.eq\('id', form\.id\)/);
  // Sanitized on save, and offers both the rich editor and an HTML-source toggle.
  assert.match(editor, /sanitizeEmailHtml\(form\.html/);
  assert.match(editor, /RichTextEditor/);
  assert.match(editor, /HTML source/);
});

test('the marketing hub renders the shared TemplateManager (no inline CRUD left)', async () => {
  const mk = await read('../app/(app)/marketing/page.tsx');
  assert.match(mk, /<TemplateManager templates=\{templates\} onChanged=\{load\} \/>/);
  assert.doesNotMatch(mk, /async function saveTemplate/);
  assert.doesNotMatch(mk, /templateForm/);
});

test('the inbox can create/select/edit templates from that page', async () => {
  const inbox = await read('../app/(app)/inbox/page.tsx');
  assert.match(inbox, /import TemplateManager from '@\/components\/TemplateManager'/);
  // A Templates button in the header opens the manager.
  assert.match(inbox, /setShowTemplates\(true\)/);
  assert.match(inbox, /<TemplateManager templates=\{templates\} onChanged=\{loadTemplates\} \/>/);
  // Wired to a reusable loader so a save/delete refreshes the composer picker.
  assert.match(inbox, /const loadTemplates = useCallback/);
  // Selecting a template into the composer still works (unchanged).
  assert.match(inbox, /applyTemplate/);
});
