import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

// Audit hardening for the link re-check (migration 0039 + lib/link-recheck.ts).

test('0039 makes claim + enqueue atomic and caps recheck jobs in flight (#3, #5)', async () => {
  const sql = await read('../supabase/migrations/0039_link_recheck_hardening.sql');
  // #3: the claim RPC inserts the jobs itself, off the claimed rows, in the same
  // statement as the last_checked_at update — a failed insert rolls the stamp back.
  assert.match(sql, /create or replace function public\.claim_due_link_rechecks/);
  assert.match(sql, /insert into public\.job_queue/);
  assert.match(sql, /'link_recheck'/);
  assert.match(sql, /from claimed/);
  // #5: an in-flight cap, counting pending/processing recheck jobs.
  assert.match(sql, /p_max_inflight int/);
  assert.match(sql, /status in \('pending', 'processing'\)/);
  assert.match(sql, /v_capacity/);
});

test('0039 record_link_recheck compare-and-sets on the probed URL (#6)', async () => {
  const sql = await read('../supabase/migrations/0039_link_recheck_hardening.sql');
  assert.match(
    sql,
    /function public\.record_link_recheck\(\s*p_link_id uuid,\s*p_result text,\s*p_expected_url text/
  );
  // The URL guard must be present in all three (gone / live / unknown) branches.
  const guards = sql.match(/url = p_expected_url/g) ?? [];
  assert.ok(guards.length >= 3, `expected the URL guard in all 3 branches, saw ${guards.length}`);
});

test('0039 confirm/dismiss only act on detected candidates (#7)', async () => {
  const sql = await read('../supabase/migrations/0039_link_recheck_hardening.sql');
  const confirm = sql.slice(sql.indexOf('function public.confirm_link_removal'), sql.length);
  assert.match(confirm.slice(0, 600), /status = 'requested' and removal_detected = true/);
  const dismiss = sql.slice(sql.indexOf('function public.dismiss_link_removal'), sql.length);
  assert.match(dismiss.slice(0, 600), /status = 'requested' and removal_detected = true/);
});

test('the scan delegates enqueue to the RPC and passes the probed URL (#3, #6)', async () => {
  const lib = await read('../lib/link-recheck.ts');
  // No Node-side enqueue anymore — the claim RPC does it atomically.
  assert.doesNotMatch(lib, /enqueueJob/);
  assert.match(lib, /p_max_inflight/);
  // runLinkRecheck hands the URL it actually probed to the CAS recording RPC.
  assert.match(lib, /p_expected_url:\s*link\.url/);
});
