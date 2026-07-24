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
import { parseCallScalerPage } from '../lib/callscaler-page.ts';
import { matchUrlRule } from '../lib/url-rule-match.ts';
import { notificationRetryUpdate } from '../lib/notification-retry.ts';
import { deliveryKey, validIdempotencyKey } from '../lib/bulk-delivery.ts';
import { maskSettingSecrets, mergeSettingSecrets } from '../lib/settings-secrets.ts';

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

test('CallScaler pagination parses the documented nested response envelope', () => {
  const page = parseCallScalerPage({
    data: {
      calls: [{ id: 'call-1' }],
      has_more: true,
      next_cursor: 'cursor-2',
    },
  });
  assert.deepEqual(page.calls, [{ id: 'call-1' }]);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor, 'cursor-2');
  assert.throws(() => parseCallScalerPage({ data: { total: 1 } }), /calls array/);
});

test('URL rules match exact hosts, subdomains, and bounded paths only', () => {
  const domainRule = { pattern: 'example.com', relevant: true };
  assert.equal(matchUrlRule('https://example.com/profile', [domainRule]), domainRule);
  assert.equal(matchUrlRule('https://news.example.com/profile', [domainRule]), domainRule);
  assert.equal(matchUrlRule('https://evil-example.com/profile', [domainRule]), null);
  assert.equal(matchUrlRule('https://example.com.attacker.test/profile', [domainRule]), null);

  const pathRule = { pattern: 'example.com/records', relevant: true };
  assert.equal(matchUrlRule('https://example.com/records/123', [pathRule]), pathRule);
  assert.equal(matchUrlRule('https://example.com/recordings/123', [pathRule]), null);
});

test('failed notification reservations receive bounded retry backoff', () => {
  const first = notificationRetryUpdate(0, 'temporary', 0);
  assert.equal(first.attempt_count, 1);
  assert.equal(first.next_retry_at, new Date(5 * 60_000).toISOString());

  const terminal = notificationRetryUpdate(4, 'permanent', 0);
  assert.equal(terminal.attempt_count, 5);
  assert.equal(terminal.next_retry_at, null);
});

test('bulk requests require stable keys and derive recipient-specific delivery keys', () => {
  const requestKey = '018f0c73-4f8a-7f62-bf29-5f60fbe60610';
  assert.equal(validIdempotencyKey(requestKey), true);
  assert.equal(validIdempotencyKey('short'), false);
  assert.equal(
    deliveryKey('email', requestKey, 'contact-1'),
    `email:${requestKey}:contact-1`
  );
});

test('integration settings mask secrets and preserve blank replacements', () => {
  const current = { api_key: 'secret-value', from_name: 'CRM' };
  const masked = maskSettingSecrets('emailit', current);
  assert.deepEqual(masked.value, { from_name: 'CRM' });
  assert.deepEqual(masked.configured, ['api_key']);

  assert.deepEqual(
    mergeSettingSecrets('emailit', current, { api_key: '', from_name: 'New name' }),
    { api_key: 'secret-value', from_name: 'New name' }
  );
  assert.deepEqual(
    mergeSettingSecrets('emailit', current, { api_key: 'replacement' }),
    { api_key: 'replacement', from_name: 'CRM' }
  );
});

test('audit remediation migration adds durable claims and delivery keys', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/0008_audit_remediation.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration, /email_normalized text[\s\S]*generated always/i);
  assert.match(migration, /processing_status text not null default 'pending'/i);
  assert.match(migration, /email_messages_delivery_key_idx/i);
  assert.match(migration, /notifications_log[\s\S]*attempt_count/i);
});
