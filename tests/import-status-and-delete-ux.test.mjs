import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('the import route applies a chosen batch status as the fallback', async () => {
  const route = await read('../app/api/import/route.ts');
  assert.match(route, /statusIds\.has\(body\.defaultStatusId\)/); // validated against real statuses
  assert.match(route, /requestedDefault \?\? statusByName\.get\('new'\)/); // else falls back to "new"
});

test('the import wizard offers a status picker and sends it', async () => {
  const page = await read('../app/(app)/import/page.tsx');
  assert.match(page, /from\('statuses'\)/);
  assert.match(page, /Status for imported contacts/);
  assert.match(page, /defaultStatusId: defaultStatusId \|\| null/);
});

test('deleting a single inbox message no longer prompts (bulk still does)', async () => {
  const inbox = await read('../app/(app)/inbox/page.tsx');
  // The single-delete confirmation (its unique wording) is gone...
  assert.doesNotMatch(inbox, /Delete this message\? A synced message also moves to Trash/);
  assert.match(inbox, /No confirm prompt: deleting a message is recoverable/);
  // ...but the multi-select bulk delete keeps its guard.
  assert.match(inbox, /Delete \$\{ids\.length\} message/);
});
