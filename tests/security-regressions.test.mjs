import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { sequenceFailureUpdate } from '../lib/sequence-retry.ts';
import {
  CONTACT_FILE_MAX_BYTES,
  validateContactFile,
  validateVoicemailFile,
} from '../lib/uploads.ts';
import { verifyBearerSecret, verifyEmailitWebhook } from '../lib/webhook-auth.ts';

test('the public landing page has no signup call', async () => {
  const source = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.auth\.signUp\s*\(/);
  assert.match(source, /provisioned by an administrator/i);
});

test('failed sequence deliveries do not advance and stop after five attempts', () => {
  const retry = sequenceFailureUpdate(0, 'temporary failure', 0);
  assert.equal(retry.attempt_count, 1);
  assert.equal(retry.next_send_at, new Date(15 * 60_000).toISOString());
  assert.equal('current_step' in retry, false);

  const terminal = sequenceFailureUpdate(4, 'permanent failure', 0);
  assert.equal(terminal.status, 'stopped');
  assert.equal(terminal.stop_reason, 'delivery_failed');
  assert.equal(terminal.next_send_at, null);
  assert.equal('current_step' in terminal, false);
});

test('query-string secrets are rejected while bearer secrets work', () => {
  const queryOnly = new Request('https://example.test/hook?secret=correct');
  assert.equal(verifyBearerSecret(queryOnly, 'correct'), false);

  const bearer = new Request('https://example.test/hook', {
    headers: { Authorization: 'Bearer correct' },
  });
  assert.equal(verifyBearerSecret(bearer, 'correct'), true);
  assert.equal(verifyBearerSecret(bearer, 'wrong'), false);
});

test('Emailit HMAC verification binds the raw body and rejects stale requests', () => {
  const rawBody = '{"event_id":"evt_123","type":"email.bounced"}';
  const timestamp = '2000000000';
  const secret = 'whsec_test';
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  assert.equal(verifyEmailitWebhook(rawBody, signature, timestamp, secret, 2000000000), true);
  assert.equal(verifyEmailitWebhook(`${rawBody} `, signature, timestamp, secret, 2000000000), false);
  assert.equal(verifyEmailitWebhook(rawBody, signature, timestamp, secret, 2000000301), false);
});

test('upload validation enforces size and active-content restrictions', () => {
  assert.equal(
    validateContactFile({ name: 'payload.html', size: 10, type: 'text/html' }),
    'HTML, SVG, and JavaScript files are not allowed'
  );
  assert.equal(
    validateContactFile({
      name: 'large.pdf',
      size: CONTACT_FILE_MAX_BYTES + 1,
      type: 'application/pdf',
    }),
    'Files must be 10 MB or smaller'
  );
  assert.equal(
    validateContactFile({ name: 'report.pdf', size: 10, type: 'application/pdf' }),
    null
  );
  assert.equal(
    validateVoicemailFile({ name: 'not-audio.pdf', size: 10, type: 'application/pdf' }),
    'An audio file is required'
  );
});

test('the forward migration contains the database-level concurrency controls', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/0003_access_and_delivery_hardening.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration, /status set default 'disabled'/i);
  assert.match(migration, /for update skip locked/i);
  assert.match(
    migration,
    /create policy "email accounts update"[\s\S]*using \(public\.is_admin\(\)\)/i
  );
  assert.match(migration, /notifications_log_dedupe_idx/i);
  assert.match(migration, /webhook_receipts/i);
});
