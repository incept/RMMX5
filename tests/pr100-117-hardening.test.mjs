import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('0054 replaces permissive marketing writes with admin-only RLS', async () => {
  const sql = await read('../supabase/migrations/0054_pr100_117_audit_hardening.sql');
  for (const legacy of [
    'templates all',
    'lists all',
    'list members all',
    'sequences all',
    'steps all',
    'enrollments all',
  ]) {
    assert.match(sql, new RegExp(`drop policy if exists "${legacy}"`));
  }
  assert.equal((sql.match(/for all\s+using \(public\.is_admin\(\)\)/g) ?? []).length, 6);
  assert.equal((sql.match(/for select\s+using \(public\.is_active\(\)\)/g) ?? []).length, 6);
});

test('inbound and engagement side effects are atomic and idempotent', async () => {
  const sql = await read('../supabase/migrations/0054_pr100_117_audit_hardening.sql');
  const inbound = await read('../lib/inbound-email.ts');
  const webhook = await read('../app/api/webhooks/emailit/route.ts');
  assert.match(sql, /inbound_effects_applied boolean not null default false/);
  assert.match(sql, /for update/);
  assert.match(sql, /finalize_inbound_email_effects/);
  assert.match(sql, /track_email_event_and_stop/);
  assert.match(inbound, /finalize_inbound_email_effects/);
  assert.match(webhook, /provider_message_id/);
  assert.doesNotMatch(webhook, /order\('created_at', \{ ascending: false \}\)/);
});

test('bulk fan-out and sequence replacement use transactional RPCs', async () => {
  const sql = await read('../supabase/migrations/0054_pr100_117_audit_hardening.sql');
  const send = await read('../app/api/email/send/route.ts');
  const sequence = await read('../app/api/email/sequences/route.ts');
  assert.match(sql, /function public\.enqueue_job_batch/);
  assert.match(sql, /v_id := null;/); // no stale RETURNING value across loop iterations
  assert.match(send, /enqueueJobsBatch\(jobs\)/);
  assert.match(sql, /function public\.save_email_sequence/);
  assert.match(sequence, /rpc\('save_email_sequence'/);
});

test('email assets have a quota, registry, and abandoned-upload cleanup', async () => {
  const sql = await read('../supabase/migrations/0054_pr100_117_audit_hardening.sql');
  const assets = await read('../lib/email-assets.ts');
  const cron = await read('../app/api/cron/tick/route.ts');
  assert.match(sql, /create table if not exists public\.email_assets/);
  assert.match(sql, /email_asset_unreferenced_bytes/);
  assert.match(assets, /EMAIL_ASSET_UNREFERENCED_LIMIT_BYTES/);
  assert.match(assets, /pruneUnreferencedEmailAssets/);
  assert.match(cron, /retention\.email_assets/);
});

test('stored bodies and signatures are sanitized at the delivery boundary', async () => {
  const send = await read('../lib/email-send.ts');
  const inbound = await read('../lib/inbound-email.ts');
  assert.match(send, /const cleanHtml = sanitizeEmailHtml/);
  assert.match(send, /sanitizeEmailHtml\(String\(account\.signature_html\)/);
  assert.match(inbound, /html: sanitizeEmailHtml/);
});

test('deployments verify schema compatibility and run CI', async () => {
  const schema = await read('../lib/schema-version.ts');
  const cron = await read('../app/api/cron/tick/route.ts');
  const workflow = await read('../.github/workflows/ci.yml');
  assert.match(schema, /REQUIRED_SCHEMA_VERSION = 54/);
  assert.match(cron, /checkSchemaVersion/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run build/);
});
