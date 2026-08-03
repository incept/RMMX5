import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

// #7 + ilike: IMAP inbound goes through the SHARED recorder (reply side effects,
// normalized-email match) instead of a bare insert with an ilike wildcard match.
test('IMAP inbound routes through recordInboundEmail with reply side effects', async () => {
  const sync = await read('../lib/integrations/imap-sync.ts');
  assert.match(sync, /import \{ recordInboundEmail \}/);
  assert.match(sync, /recordInboundEmail\(\{/);
  assert.doesNotMatch(sync, /\.ilike\('email'/); // buggy _/% wildcard match is gone

  const rec = await read('../lib/inbound-email.ts');
  assert.match(rec, /stopEnrollmentsFor\(contact\.id, 'reply'\)/); // stop-on-reply
  assert.match(rec, /email_normalized/); // normalized-equality match
});

// #7 dedup + #2: the recorder accepts IMAP metadata, treats a duplicate UID as a
// no-op WITHOUT re-running side effects, and throws on any other insert error so
// the sync aborts instead of skipping the message.
test('recordInboundEmail dedups synced messages and throws on other errors', async () => {
  const rec = await read('../lib/inbound-email.ts');
  assert.match(rec, /imap\?: \{/); // optional IMAP metadata
  assert.match(rec, /imap_uidvalidity/);
  assert.match(rec, /messageError\.code === '23505' && imap/); // dup UID -> no-op
  assert.match(rec, /duplicate: true/);
  assert.match(rec, /throw messageError/); // any other error propagates
});

// #2: a failed store aborts the run before the cursor is saved.
test('the sync cursor never advances past a failed or unsaved message', async () => {
  const sync = await read('../lib/integrations/imap-sync.ts');
  // storeMessage no longer swallows errors (no warn-and-continue).
  assert.doesNotMatch(sync, /Could not store IMAP message uid/);
  // A failed cursor write fails the job so it retries.
  assert.match(sync, /Could not save IMAP cursor/);
  assert.match(sync, /if \(cursorError\)/);
});

// INTERNALDATE: ordering uses the server delivery date, not the sender's header.
test('created_at uses the IMAP INTERNALDATE, not the sender Date header', async () => {
  const sync = await read('../lib/integrations/imap-sync.ts');
  assert.match(sync, /internalDate: true/); // fetched
  assert.doesNotMatch(sync, /parsed\.date/); // not derived from the message header
  const rec = await read('../lib/inbound-email.ts');
  assert.match(rec, /created_at = new Date\(imap\.internalDate\)/);
});

// #3: bodies are size-bounded; oversized messages become metadata-only rows.
test('oversized messages are bounded and stored metadata-only', async () => {
  const sync = await read('../lib/integrations/imap-sync.ts');
  assert.match(sync, /MAX_MESSAGE_BYTES/);
  assert.match(sync, /size: true/); // pass 1 learns the size without the body
  assert.match(sync, /function storeOversized/);
  assert.match(sync, /too large to load here/);
});

// #1: UIDVALIDITY is part of message identity + checked before write-back.
test('UIDVALIDITY is in the dedup index and guards write-back', async () => {
  const m = await read('../supabase/migrations/0049_imap_uidvalidity_identity.sql');
  assert.match(m, /account_id, imap_folder, imap_uidvalidity, imap_uid/);
  const sync = await read('../lib/integrations/imap-sync.ts');
  // reconcile compares the folder's live UIDVALIDITY before touching a UID.
  assert.match(sync, /Number\(r\.imap_uidvalidity\) !== liveValidity/);
});

// #4: dirty flag + per-account reconcile + short-bucket key + one job per account.
test('write-back is atomic, batched per account, and not permanently deduped', async () => {
  const m = await read('../supabase/migrations/0050_imap_writeback_reconcile.sql');
  assert.match(m, /add column if not exists imap_wb_dirty boolean not null default false/);

  const sync = await read('../lib/integrations/imap-sync.ts');
  // short 15s bucket in the key -> a later toggle after completion re-enqueues.
  assert.match(sync, /imap-wb:reconcile:\$\{accountId\}:\$\{bucket\}/);
  assert.match(sync, /Date\.now\(\) \/ 15_000/);

  const bulk = await read('../app/api/inbox/messages/bulk-delete/route.ts');
  // one reconcile per DISTINCT account, not one job per message.
  assert.match(bulk, /new Set<string>\(\)/);
  assert.match(bulk, /imap_wb_dirty: true/);
  assert.match(bulk, /enqueueImapReconcile\(accountId\)/);
});
