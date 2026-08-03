import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

// Finding #9: make Emailit delivery reliable under retries and multiple app
// processes — v2 send + Idempotency-Key, plus a DB-coordinated rate gate.

test('0040 adds a shared provider send-slot gate that advances by the interval', async () => {
  const sql = await read('../supabase/migrations/0040_provider_rate_gate.sql');
  assert.match(sql, /create table if not exists public\.provider_rate_limits/);
  assert.match(sql, /function public\.claim_provider_send_slot/);
  // The slot advances by the interval from the later of {previous slot, now()},
  // and concurrent callers serialize on the upsert's row lock.
  assert.match(sql, /greatest\(\s*prl\.last_send_at \+ make_interval/);
  assert.match(sql, /on conflict \(provider\) do update/);
  // Locked down to service_role.
  assert.match(
    sql,
    /grant execute on function public\.claim_provider_send_slot\(text, int\) to service_role/
  );
});

test('Emailit sends on v2 with an Idempotency-Key and a cross-process rate gate', async () => {
  const lib = await read('../lib/integrations/emailit.ts');
  // v1 -> v2 (idempotency is a v2 feature).
  assert.match(lib, /api\.emailit\.com\/v2\/emails/);
  assert.doesNotMatch(lib, /api\.emailit\.com\/v1\/emails/);
  // A caller-supplied stable id becomes the Idempotency-Key header.
  assert.match(lib, /idempotencyKey\?: string/);
  assert.match(lib, /headers\['Idempotency-Key'\] = opts\.idempotencyKey/);
  // The throttle reserves a slot from the shared DB clock, with a local fallback.
  assert.match(lib, /function reserveEmailitSlotMs/);
  assert.match(lib, /claim_provider_send_slot/);
  assert.match(lib, /lastEmailitSendAt \+ EMAILIT_MIN_INTERVAL_MS - Date\.now\(\)/);
});

test('delivery paths pass a stable idempotency key to Emailit', async () => {
  const send = await read('../lib/email-send.ts');
  // The message row id keys the send, so a retried delivery cannot double-send.
  assert.match(send, /idempotencyKey: row\.id/);

  const jobs = await read('../lib/job-queue.ts');
  // A retried notification delivery is deduped by its notification id.
  assert.match(jobs, /idempotencyKey: String\(payload\.notificationId\)/);
});
