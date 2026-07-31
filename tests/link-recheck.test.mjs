import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('0038 adds re-check state, registers link_recheck, and claims due CLIENT links only', async () => {
  const sql = await read('../supabase/migrations/0038_link_recheck.sql');
  assert.match(sql, /add column if not exists last_checked_at/);
  assert.match(sql, /add column if not exists gone_streak/);
  assert.match(sql, /add column if not exists removal_detected/);
  // Registered as a job kind, but kept OFF the light (delivery) lane.
  assert.match(sql, /'contact_side_effects', 'link_recheck'/);
  assert.match(sql, /kind not in \('deep_search', 'auto_search', 'link_recheck'\)/);
  // Due-claim is clients-only and stamps last_checked_at at claim time.
  assert.match(sql, /function public\.claim_due_link_rechecks/);
  assert.match(sql, /s\.is_client_status = true/);
  assert.match(sql, /set last_checked_at = now\(\)/);
  // 3-in-a-row threshold; unknown reads never advance the streak.
  assert.match(sql, /function public\.record_link_recheck/);
  assert.match(sql, /p_threshold int default 3/);
  assert.match(sql, /gone_streak \+ 1 >= greatest\(p_threshold, 1\)/);
  // Confirm flips to removed and fires the client alert; dismiss keeps it requested.
  assert.match(sql, /function public\.confirm_link_removal/);
  assert.match(sql, /status = 'removed'/);
  assert.match(sql, /'event', 'link_status_change'/);
  assert.match(sql, /function public\.dismiss_link_removal/);
});

test('probeLinkLiveness skips the billable tier and never reads a block as gone', async () => {
  const lib = await read('../lib/deep-search/fetch-page.ts');
  assert.match(lib, /noUnlocker\?: boolean/);
  assert.match(lib, /export async function probeLinkLiveness/);
  assert.match(lib, /noUnlocker: true/);
  // A definitive not-found with no block signal is gone; a block stays unknown.
  assert.match(lib, /goneSignal && !blockSignal/);
  assert.match(lib, /state: 'unknown'/);
  // Content check: the page still naming the client means it's live.
  assert.match(lib, /function pageMentionsName/);
});

test('the scan enqueues heavy link_recheck jobs; the job records but never auto-flips', async () => {
  const lib = await read('../lib/link-recheck.ts');
  assert.match(lib, /claim_due_link_rechecks/);
  assert.match(lib, /enqueueJob\(\s*'link_recheck'/);
  assert.match(lib, /function runLinkRecheck/);
  assert.match(lib, /probeLinkLiveness/);
  assert.match(lib, /record_link_recheck/);
  // Option B — the job only records the streak; it never confirms the removal
  // itself (that RPC is admin-only, called from the queue).
  assert.doesNotMatch(lib, /confirm_link_removal/);

  const jobs = await read('../lib/job-queue.ts');
  assert.match(jobs, /\| 'link_recheck'/);
  assert.match(jobs, /job\.kind === 'link_recheck'/);

  const tick = await read('../app/api/cron/tick/route.ts');
  assert.match(tick, /processLinkRechecks\(\)/);
});

test('the confirmation queue is admin-only with one-click confirm / dismiss', async () => {
  const route = await read('../app/api/link-removals/route.ts');
  assert.match(route, /requireAdmin/);
  assert.match(route, /removal_detected', true/);
  assert.match(route, /confirm_link_removal/);
  assert.match(route, /dismiss_link_removal/);

  const page = await read('../app/(app)/admin/link-removals/page.tsx');
  assert.match(page, /Confirm removed/);
  assert.match(page, /Still up/);

  const sidebar = await read('../components/Sidebar.tsx');
  assert.match(sidebar, /Link Removals/);
});
