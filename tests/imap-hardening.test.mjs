import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isPrivateMailAddress, validateImapTarget, validateSmtpTarget } from '../lib/imap-target.ts';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

// #8: IMAP has its own job lane; the heavy lane no longer claims it.
test('IMAP jobs run on their own lane, separate from deep search', async () => {
  const m = await read('../supabase/migrations/0051_imap_job_lane.sql');
  assert.match(m, /function public\.claim_imap_jobs/);
  assert.match(m, /kind in \('imap_sync', 'imap_writeback'\)/);
  // claim_jobs (heavy lane) now excludes imap kinds.
  assert.match(m, /kind not in \('imap_sync', 'imap_writeback'\)/);
  assert.match(m, /grant execute on function public\.claim_imap_jobs\(text, int, int\) to service_role/);

  const queue = await read('../lib/job-queue.ts');
  assert.match(queue, /opts\?\.imap \? 'claim_imap_jobs'/);
  const tick = await read('../app/api/cron/tick/route.ts');
  assert.match(tick, /processQueuedJobs\(3, \{ imap: true \}\)/);
});

// #8 hardening: the enqueue helpers surface account-query errors.
test('IMAP enqueue helpers log account-query errors instead of reporting zero', async () => {
  const sync = await read('../lib/integrations/imap-sync.ts');
  assert.match(sync, /Could not list IMAP accounts for periodic sync/);
  assert.match(sync, /Could not list IMAP accounts for manual sync/);
});

// #5: SSRF guard + credential-redirection protection.
test('IMAP targets are SSRF-guarded and restricted to standard ports', async () => {
  const guard = await read('../lib/imap-target.ts');
  assert.match(guard, /export function validateImapTarget/);
  assert.match(guard, /IMAP_PORTS = new Set\(\[143, 993\]\)/);
  assert.match(guard, /localhost/);
  assert.match(guard, /Only 2000::\/3 is globally routed unicast/);
  assert.match(guard, /lookup\(originalHost, \{ all: true, verbatim: true \}\)/);
  assert.match(guard, /answers\.some\(\(answer\) => isPrivateMailAddress/);
});

test('mail target validation rejects local, reserved, and transition addresses', () => {
  for (const address of [
    '127.0.0.1',
    '10.2.3.4',
    '169.254.169.254',
    '192.0.0.55',
    '198.51.100.8',
    '::1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '2002:7f00:1::',
  ]) {
    assert.equal(isPrivateMailAddress(address), true, address);
  }
  assert.equal(isPrivateMailAddress('8.8.8.8'), false);
  assert.equal(isPrivateMailAddress('2606:4700:4700::1111'), false);
  assert.match(String(validateImapTarget('localhost', 993)), /not allowed/);
  assert.match(String(validateImapTarget('mail.example.com', 25)), /143 or 993/);
  assert.match(String(validateSmtpTarget('mail.example.com', 143)), /25, 465, 587, or 2525/);
});

test('test-imap reuses the whole stored tuple, not the stored password with a new host', async () => {
  const route = await read('../app/api/admin/email-accounts/test-imap/route.ts');
  assert.match(route, /validateImapTarget/);
  // On a blank-password test, host/username/etc come from the stored row.
  assert.match(route, /host = data\.imap_host/);
  assert.match(route, /password = data\.imap_password/);
  assert.match(route, /No stored IMAP password/);
});

test('changing the IMAP host/port/username requires re-entering the password', async () => {
  const route = await read('../app/api/admin/email-accounts/[id]/route.ts');
  assert.match(route, /validateImapTarget/);
  assert.match(route, /resolvePublicMailTarget/);
  assert.match(route, /Re-enter the IMAP password/);
  assert.match(route, /identityChanged/);
  // The create route SSRF-guards its target too.
  const create = await read('../app/api/admin/email-accounts/route.ts');
  assert.match(create, /validateImapTarget/);
});

// Remote images / tracking pixels are blocked until the reader opts in.
test('the inbox blocks remote images until Load images is clicked', async () => {
  const inbox = await read('../app/(app)/inbox/page.tsx');
  // The image-blocking CSP now lives in the shared frame helper.
  const frame = await read('../lib/email-frame.ts');
  assert.match(frame, /Content-Security-Policy" content="img-src data:;/);
  assert.match(inbox, /Load images/);
  assert.match(inbox, /setImagesLoaded/);
});
