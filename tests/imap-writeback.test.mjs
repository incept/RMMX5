import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('0046 adds read state + the imap_writeback heavy job', async () => {
  const m = await read('../supabase/migrations/0046_imap_writeback.sql');
  assert.match(m, /add column if not exists seen boolean not null default false/);
  assert.match(m, /job_queue_kind_check[\s\S]*'imap_writeback'/);
  assert.match(
    m,
    /not in \('deep_search', 'auto_search', 'link_recheck', 'imap_sync', 'imap_writeback'\)/
  );
});

test('write-back is a per-account state-convergent reconciler, not per-action', async () => {
  const sync = await read('../lib/integrations/imap-sync.ts');
  assert.match(sync, /export async function runImapReconcile/);
  assert.match(sync, /export async function enqueueImapReconcile/);
  assert.match(sync, /function reconcileWriteback/);
  assert.match(sync, /messageFlagsAdd/); // mark read
  assert.match(sync, /messageMove/); // delete -> Trash
  // Reconciliation hides server-deleted mail and updates the read flag.
  assert.match(sync, /reconcileRecent/);
  assert.match(sync, /hidden_at/);
});

test('the queue routes imap_writeback for both append_sent and reconcile', async () => {
  const queue = await read('../lib/job-queue.ts');
  assert.match(queue, /\|\s*'imap_writeback'/);
  assert.match(queue, /job\.kind === 'imap_writeback'/);
  assert.match(queue, /runImapWriteback\('append_sent', messageId, signal\)/);
  assert.match(queue, /runImapWriteback\('reconcile', accountId, signal\)/);
});

test('the inbox message route marks read + deletes, gated on a user', async () => {
  const route = await read('../app/api/inbox/messages/[id]/route.ts');
  assert.match(route, /requireUser/);
  assert.match(route, /export async function PATCH/);
  assert.match(route, /export async function DELETE/);
  assert.match(route, /enqueueImapReconcile/);
  assert.match(route, /imap_wb_dirty: true/); // set atomically with the state change
  assert.match(route, /hidden_at/);
});

test('the inbox opens = read, hides deleted, shows unread', async () => {
  const inbox = await read('../app/(app)/inbox/page.tsx');
  assert.match(inbox, /function openMessage/);
  assert.match(inbox, /function deleteMessage/);
  assert.match(inbox, /\.is\('hidden_at', null\)/);
  assert.match(inbox, /Unread/);
});
