import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('credential-bearing endpoints require super-admin authority and a fresh secret', async () => {
  const settings = await read('app/api/admin/settings/route.ts');
  const browser = await read('lib/deep-search/browser.ts');
  assert.match(settings, /credential-bearing endpoint/);
  assert.match(settings, /auth\.profile\.role !== 'super_admin'/);
  assert.match(settings, /must be re-entered when the endpoint changes/);
  assert.match(settings, /await assertPublicHttpsUrl/);
  assert.match(settings, /apiFailure\('api:admin\/settings', error, \{ context: \{ key: body\.key \} \}\)/);
  assert.match(browser, /await assertPublicHttpsUrl\(cfg\.remote_url\)/);
});

test('remote browser lifecycle and DOM work are bounded', async () => {
  const worker = await read('browser-worker/server.mjs');
  assert.match(worker, /IDLE_SHUTDOWN_MS/);
  assert.match(worker, /MAX_DOM_NODES/);
  assert.match(worker, /browser context close/);
  assert.match(worker, /SIGKILL/);
  assert.match(worker, /'stylesheet'/);
});

test('an unavailable remote browser cannot fall into a billable unlocker', async () => {
  const browser = await read('lib/deep-search/browser.ts');
  const fetchPage = await read('lib/deep-search/fetch-page.ts');
  assert.match(browser, /remoteHealthy/);
  assert.match(browser, /remoteCircuitOpenUntil/);
  assert.match(fetchPage, /opts\?\.needsBrowser && !viaBrowser\.ok && viaBrowser\.unavailable/);
});

test('contact authorization is enforced below the React UI', async () => {
  const migration = await read('supabase/migrations/0031_audit_hardening.sql');
  const panel = await read('components/ContactPanel.tsx');
  const clients = await read('app/(app)/clients/page.tsx');
  assert.match(migration, /revoke select, insert, update on table public\.contacts from authenticated/);
  assert.doesNotMatch(
    migration.match(/grant select \([\s\S]*?\) on table public\.contacts to authenticated/)?.[0] ?? '',
    /revenue_projection/
  );
  const route = await read('app/api/contacts/[id]/route.ts');
  assert.ok(panel.includes('fetch(`/api/contacts/${contactId}'));
  assert.ok(clients.includes('fetch(`/api/clients?page=${page}'));
  assert.match(route, /const \{ data: after[\s\S]*?delete \(after as Record<string, any>\)\.revenue_projection/);
});

test('candidate batches are fenced by the exact queue lease', async () => {
  const migration = await read('supabase/migrations/0031_audit_hardening.sql');
  const deepSearch = await read('lib/deep-search/index.ts');
  assert.match(migration, /write_deep_search_candidates/);
  assert.match(migration, /j\.locked_by = p_worker/);
  assert.match(migration, /j\.attempt_count = p_attempt_count/);
  assert.match(migration, /for update/);
  assert.match(deepSearch, /write_deep_search_candidates/);
  assert.match(deepSearch, /deep-search:activity/);
});

test('contact search and retention paths are bounded', async () => {
  const migration = await read('supabase/migrations/0031_audit_hardening.sql');
  assert.match(migration, /create extension if not exists pg_trgm/);
  assert.match(migration, /with filtered as not materialized/);
  assert.match(migration, /status = 'new'.*180 days/s);
  assert.match(migration, /activity_log.*730 days/s);
  assert.match(migration, /email_messages.*730 days/s);
});

test('probe-site failures use a logged server API and visible UI state', async () => {
  const page = await read('app/(app)/admin/deep-search-sites/page.tsx');
  const route = await read('app/api/admin/probe-sites/route.ts');
  assert.match(page, /loadError/);
  assert.match(page, /\/api\/admin\/probe-sites/);
  assert.match(route, /apiFailure\('api:admin\/probe-sites'/);
  assert.match(route, /admin:probe-sites/);
  assert.match(route, /!state \|\| !STATE_CODES\.has\(state\)/);
});
