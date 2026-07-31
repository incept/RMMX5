import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('migration adds the admin countdown event and idempotently seeds a disabled rule', async () => {
  const sql = await readFile(
    new URL('../supabase/migrations/0037_admin_countdown.sql', import.meta.url),
    'utf8'
  );
  assert.match(sql, /add constraint notification_rules_event_check/);
  assert.match(sql, /'client_countdown_admin'/);
  assert.match(sql, /recipient_user_ids/);
  // Re-runnable: the seed only inserts when the rule is absent.
  assert.match(sql, /where not exists/i);
});

test('the countdown scan alerts each recipient profile by email and SMS, deduped per person', async () => {
  const lib = await readFile(new URL('../lib/notifications.ts', import.meta.url), 'utf8');
  assert.match(lib, /function fireAdminCountdown/);
  // Both rule kinds are scanned together; admin recipients preloaded once.
  assert.match(lib, /\['client_countdown', 'client_countdown_admin'\]/);
  assert.match(lib, /from\('profiles'\)/);
  // Delivery goes to the user's own email/phone, not the client's.
  assert.match(lib, /channel === 'email' \? user\.email : user\.phone/);
  // SMS is skipped for a recipient with no phone on file.
  assert.match(lib, /if \(!destination\) continue/);
  // Per-recipient, per-channel dedupe so one reservation can't block another.
  assert.match(lib, /countdown-admin:\$\{rule\.id\}:\$\{contact\.id\}[\s\S]*\$\{user\.id\}:\$\{channel\}/);
});

test('notification delivery carries a custom subject for internal alerts', async () => {
  const jobs = await readFile(new URL('../lib/job-queue.ts', import.meta.url), 'utf8');
  // The email send honours a payload subject, defaulting to the client-facing one.
  assert.match(jobs, /payload\.subject/);
  assert.match(jobs, /'Update on your case'/);
});

test('the notifications page shows an internal-countdown card with a recipient picker', async () => {
  const page = await readFile(
    new URL('../app/(app)/admin/notifications/page.tsx', import.meta.url),
    'utf8'
  );
  assert.match(page, /client_countdown_admin/);
  assert.match(page, /Client countdown \(internal\)/);
  assert.match(page, /recipient_user_ids/);
  // Picker is fed by active team members read from profiles.
  assert.match(page, /from\('profiles'\)/);
  assert.match(page, /status', 'active'/);
});
