import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('the Emailit webhook catches email.received and records it in the inbox', async () => {
  const route = await readFile(
    new URL('../app/api/webhooks/emailit/route.ts', import.meta.url),
    'utf8'
  );
  assert.match(route, /email\.received/);
  // The email id is read from the documented data.object.id envelope.
  assert.match(route, /object\?\.id/);
  // #1: headers come from the webhook's data.object; only the body is fetched.
  assert.match(route, /fetchEmailitBody/);
  assert.doesNotMatch(route, /fetchEmailitMessage/);
  assert.match(route, /from: String\(object\.from/);
  assert.match(route, /subject: String\(object\.subject/);
  assert.match(route, /recordInboundEmail/);
  // Inbound is still signature-verified and de-duplicated like the bounce path.
  assert.match(route, /verifyEmailitWebhook/);
  assert.match(route, /claimWebhookReceipt\('emailit', receivedEventId\)/);
  assert.match(route, /releaseWebhookReceipt\('emailit', receivedEventId\)/);
});

test('inbound body fetch uses the body-only v2 endpoint, not the attachment-bearing full GET (#1)', async () => {
  const lib = await readFile(new URL('../lib/integrations/emailit.ts', import.meta.url), 'utf8');
  assert.match(lib, /export async function fetchEmailitBody/);
  // The dedicated /body endpoint returns only text+html — no base64 attachments
  // that could breach the 1 MiB response cap.
  assert.match(lib, /api\.emailit\.com\/v2\/emails\/\$\{id\}\/body/);
  assert.match(lib, /Authorization: `Bearer \$\{cfg\.api_key\}`/);
  // The webhook-supplied id is constrained before it reshapes the URL.
  assert.match(lib, /\[A-Za-z0-9_-\]\{1,128\}/);
  // /body returns { text, html } at the top level (not under body.*).
  assert.match(lib, /data\?\.html/);
  assert.match(lib, /data\?\.text/);
});

test('both inbound paths share one recorder with transactional reply finalization', async () => {
  const lib = await readFile(new URL('../lib/inbound-email.ts', import.meta.url), 'utf8');
  assert.match(lib, /export async function recordInboundEmail/);
  assert.match(lib, /direction: 'inbound'/);
  assert.match(lib, /email_normalized/);
  assert.match(lib, /finalize_inbound_email_effects/);

  // The generic forwarder webhook now delegates to the same recorder.
  const generic = await readFile(
    new URL('../app/api/webhooks/inbound-email/route.ts', import.meta.url),
    'utf8'
  );
  assert.match(generic, /recordInboundEmail/);
  assert.doesNotMatch(generic, /direction: 'inbound'/); // logic moved out, not duplicated
});
