import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('0045 registers imap_sync (heavy lane) and the sync schema', async () => {
  const m = await read('../supabase/migrations/0045_imap_read_sync.sql');
  assert.match(m, /job_queue_kind_check[\s\S]*'imap_sync'/); // allowed by the DB constraint
  // Kept OFF the light lane (heavy-only, like the searches).
  assert.match(m, /not in \('deep_search', 'auto_search', 'link_recheck', 'imap_sync'\)/);
  assert.match(m, /add column if not exists imap_uid bigint/);
  assert.match(m, /add column if not exists hidden_at timestamptz/);
  assert.match(m, /unique index[\s\S]*email_messages[\s\S]*imap_uid/);
  assert.match(m, /create table if not exists public\.imap_folder_state/);
});

test('the queue routes imap_sync to the mailbox syncer', async () => {
  const queue = await read('../lib/job-queue.ts');
  assert.match(queue, /\|\s*'imap_sync'/); // in the JobKind union
  assert.match(queue, /job\.kind === 'imap_sync'/);
  assert.match(queue, /runImapSync\(accountId, signal\)/);
});

test('the sync engine pulls INBOX with imapflow + mailparser, gated on imap_enabled', async () => {
  const sync = await read('../lib/integrations/imap-sync.ts');
  assert.match(sync, /from 'imapflow'/);
  assert.match(sync, /from 'mailparser'/);
  assert.match(sync, /imap_enabled/);
  assert.match(sync, /direction: 'inbound'/);
  assert.match(sync, /imap_folder_state/);
  assert.match(sync, /export async function enqueueDueImapSyncs/);
});

test('the cron tick enqueues due IMAP syncs', async () => {
  const tick = await read('../app/api/cron/tick/route.ts');
  assert.match(tick, /enqueueDueImapSyncs/);
});
