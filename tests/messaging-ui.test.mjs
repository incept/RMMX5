import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('the sidebar section is labelled Messaging', async () => {
  const sidebar = await readFile(new URL('../components/Sidebar.tsx', import.meta.url), 'utf8');
  assert.match(sidebar, /label: 'Messaging'/);
  assert.doesNotMatch(sidebar, /label: 'Outreach'/);
});

test('the email preview frame is theme-matched, not a bare white/serif block', async () => {
  const inbox = await readFile(new URL('../app/(app)/inbox/page.tsx', import.meta.url), 'utf8');
  // Body wrapped in a themed document (surface bg + gray-900 text + app font).
  assert.match(inbox, /function framedEmail/);
  assert.match(inbox, /srcDoc=\{framedEmail\(/);
  // Both palettes present so the frame flips with the app.
  assert.match(inbox, /#282c34/); // --color-surface, dark
  assert.match(inbox, /#ffffff/); // --color-surface, light
  // Repaints when the <html class="dark"> toggle changes.
  assert.match(inbox, /attributeFilter: \['class'\]/);
  // Still sandboxed — inbound HTML must never run scripts.
  assert.match(inbox, /sandbox="allow-popups"/);
});
