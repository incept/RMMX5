import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

// Deleting a contact must remove ALL of their data (GDPR erasure). Four child
// tables used to be ON DELETE SET NULL — the rows survived with contact_id
// nulled — and job_queue / import_chunks had no contact FK at all. Migration
// 0052 closes every one of those gaps.
test('migration 0052 fully purges a deleted contact', async () => {
  const m = await read('../supabase/migrations/0052_purge_contact_on_delete.sql');

  // The four previously-SET NULL tables are the migration's targets, re-pointed
  // at ON DELETE CASCADE.
  for (const t of ['email_messages', 'calls', 'webhook_leads', 'debug_log']) {
    assert.ok(m.includes(`'${t}'`), `migration targets ${t}`);
  }
  assert.match(m, /on delete cascade/);

  // job_queue rows for the contact are DELETED now, not left marked 'failed'.
  assert.match(m, /delete from public\.job_queue/);
  assert.doesNotMatch(m, /Contact was deleted or merged/); // the old just-fail marker is gone

  // A running (processing) job still blocks the delete — the worker holds a lease.
  assert.match(m, /raise exception 'Contact has background work in progress/);

  // The contact id is stripped from any import batch's uuid[] (array, no FK).
  assert.match(m, /array_remove\(contact_ids, old\.id\)/);
});
