import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('RichTextEditor: contentEditable surface with core formatting commands', async () => {
  const src = await read('../components/RichTextEditor.tsx');
  assert.match(src, /contentEditable/);
  assert.match(src, /execCommand/);
  assert.match(src, /'bold'/);
  assert.match(src, /'italic'/);
  assert.match(src, /insertUnorderedList/);
  assert.match(src, /insertOrderedList/);
  assert.match(src, /foreColor/); // text color
  assert.match(src, /formatBlock/); // headings / quote
});

test('RichTextEditor: link + image (upload and by-URL) insertion', async () => {
  const src = await read('../components/RichTextEditor.tsx');
  assert.match(src, /addLink/);
  assert.match(src, /rel="noopener noreferrer"/);
  assert.match(src, /onImageUpload/);
  assert.match(src, /addImageByUrl/);
  assert.match(src, /type="file"/);
});

test('RichTextEditor: pasted clipboard HTML is scrubbed, never inserted raw', async () => {
  const src = await read('../components/RichTextEditor.tsx');
  assert.match(src, /onPaste/);
  assert.match(src, /scrubPastedHtml/);
  // scrubber removes scripts and inline handlers
  assert.match(src, /script\|style\|meta\|link\|title\|head\|iframe\|object\|embed/);
  assert.match(src, /\\son\[a-z\]\+/);
});

test('all three compose surfaces import the editor + shared image uploader', async () => {
  for (const p of [
    '../app/(app)/inbox/page.tsx',
    '../app/(app)/marketing/page.tsx',
    '../components/ContactPanel.tsx',
  ]) {
    const src = await read(p);
    assert.match(src, /import RichTextEditor[^\n]*from '@\/components\/RichTextEditor'/, `${p} editor`);
  }
  const inbox = await read('../app/(app)/inbox/page.tsx');
  const cp = await read('../components/ContactPanel.tsx');
  const mk = await read('../app/(app)/marketing/page.tsx');
  assert.match(inbox, /uploadEmailImage/);
  assert.match(cp, /uploadEmailImage/);
  assert.match(mk, /uploadEmailImage/);
});

test('inbox + contact panel expose a template picker that fills the composer', async () => {
  const inbox = await read('../app/(app)/inbox/page.tsx');
  assert.match(inbox, /applyTemplate/);
  assert.match(inbox, /Insert template/);
  assert.match(inbox, /from\('email_templates'\)/);
  const cp = await read('../components/ContactPanel.tsx');
  assert.match(cp, /applyTemplate/);
  assert.match(cp, /Insert template/);
  assert.match(cp, /from\('email_templates'\)/);
});

test('compose send paths pass editor HTML directly (no newline->br hack)', async () => {
  const inbox = await read('../app/(app)/inbox/page.tsx');
  const cp = await read('../components/ContactPanel.tsx');
  assert.match(inbox, /html: compose\.html,/);
  assert.match(cp, /html: compose\.html,/);
  assert.doesNotMatch(inbox, /compose\.html\.replace\(\/\\n\/g/);
  assert.doesNotMatch(cp, /compose\.html\.replace\(\/\\n\/g/);
});

test('send route sanitizes compose HTML server-side', async () => {
  const route = await read('../app/api/email/send/route.ts');
  assert.match(route, /import \{ sanitizeEmailHtml \}/);
  assert.match(route, /sanitizeEmailHtml\(String\(body\.html/);
});

test('marketing template save sanitizes stored HTML + offers an HTML-source toggle', async () => {
  const mk = await read('../app/(app)/marketing/page.tsx');
  assert.match(mk, /sanitizeEmailHtml\(f\.html/);
  assert.match(mk, /templateSource/);
  assert.match(mk, /HTML source/);
});

test('renderTemplate lives in a pure, server-free module and is re-exported', async () => {
  const mod = await read('../lib/render-template.ts');
  assert.match(mod, /export function renderTemplate/);
  assert.doesNotMatch(mod, /@\/lib\/supabase\/server/);
  assert.doesNotMatch(mod, /@\/lib\/email-send/);
  const runner = await read('../lib/sequence-runner.ts');
  assert.match(runner, /from '@\/lib\/render-template'/);
  assert.match(runner, /export \{ renderTemplate \}/);
});
