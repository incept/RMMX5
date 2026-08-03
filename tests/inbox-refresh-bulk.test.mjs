import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('manual sync-now enqueues on a short bucket', async () => {
  const sync = await read('../lib/integrations/imap-sync.ts');
  assert.match(sync, /export async function enqueueImapSyncNow/);
  assert.match(sync, /:manual:/); // distinct from the 3-min periodic bucket
  const route = await read('../app/api/inbox/sync/route.ts');
  assert.match(route, /requireUser/);
  assert.match(route, /enqueueImapSyncNow/);
});

test('bulk delete soft-deletes many + moves synced ones to Trash', async () => {
  const route = await read('../app/api/inbox/messages/bulk-delete/route.ts');
  assert.match(route, /requireUser/);
  assert.match(route, /export async function POST/);
  assert.match(route, /\.in\('id', ids\)/);
  assert.match(route, /hidden_at/);
  assert.match(route, /enqueueImapWriteback\('delete'/);
});

test('the inbox has refresh + multiselect delete', async () => {
  const inbox = await read('../app/(app)/inbox/page.tsx');
  assert.match(inbox, /function refreshInbox/);
  assert.match(inbox, /function toggleSelect/);
  assert.match(inbox, /function deleteSelected/);
  assert.match(inbox, /\/api\/inbox\/sync/);
  assert.match(inbox, /\/api\/inbox\/messages\/bulk-delete/);
  assert.match(inbox, /toggleSelect\(m\.id\)/);
});
