import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('the sidebar section is labelled Messaging', async () => {
  const sidebar = await read('../components/Sidebar.tsx');
  assert.match(sidebar, /label: 'Messaging'/);
  assert.doesNotMatch(sidebar, /label: 'Outreach'/);
});

test('framedEmail is a shared, theme-matched, sandbox-ready helper', async () => {
  const frame = await read('../lib/email-frame.ts');
  assert.match(frame, /export function framedEmail/);
  // Both palettes present so the frame flips with the app.
  assert.match(frame, /#282c34/); // --color-surface, dark
  assert.match(frame, /#ffffff/); // --color-surface, light
  // Blocks remote images (and tracking pixels) when asked.
  assert.match(frame, /img-src data:/);
  // Links open in a new tab.
  assert.match(frame, /<base target="_blank">/);
});

test('the inbox renders messages through the shared frame in a script-free sandbox', async () => {
  const inbox = await read('../app/(app)/inbox/page.tsx');
  assert.match(inbox, /import \{ framedEmail \} from '@\/lib\/email-frame'/);
  assert.match(inbox, /srcDoc=\{framedEmail\(/);
  // Script-free, but a clicked link escapes to a real new tab (not a sandboxed one).
  assert.match(inbox, /sandbox="allow-popups allow-popups-to-escape-sandbox"/);
  // The local copy is gone — one definition, in the lib.
  assert.doesNotMatch(inbox, /function framedEmail/);
  // Repaints when the <html class="dark"> toggle changes.
  assert.match(inbox, /attributeFilter: \['class'\]/);
});

test('the contact panel lets you open a past email and resend it with edits', async () => {
  const panel = await read('../components/ContactPanel.tsx');
  assert.match(panel, /import \{ framedEmail \} from '@\/lib\/email-frame'/);
  // History rows are clickable and open the viewer.
  assert.match(panel, /onClick=\{\(\) => setViewingMessage\(m\)\}/);
  // The viewer renders the body in the same sandboxed, themed frame as the inbox.
  assert.match(panel, /srcDoc=\{framedEmail\(/);
  assert.match(panel, /sandbox="allow-popups allow-popups-to-escape-sandbox"/);
  // Resend drops the message back into the composer with a fresh idempotency key
  // (blank requestKey) so it is a new delivery, not a dedup of the original.
  assert.match(panel, /function resendMessage/);
  assert.match(panel, /requestKey: ''/);
  assert.match(panel, /Resend with edits/);
});
