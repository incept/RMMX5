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
  assert.match(route, /fetchEmailitMessage/);
  assert.match(route, /recordInboundEmail/);
  // Inbound is still signature-verified and de-duplicated like the bounce path.
  assert.match(route, /verifyEmailitWebhook/);
  assert.match(route, /claimWebhookReceipt\('emailit', receivedEventId\)/);
  assert.match(route, /releaseWebhookReceipt\('emailit', receivedEventId\)/);
});

test('Get Email hits the v2 endpoint with a bearer key and a bounded id', async () => {
  const lib = await readFile(new URL('../lib/integrations/emailit.ts', import.meta.url), 'utf8');
  assert.match(lib, /export async function fetchEmailitMessage/);
  assert.match(lib, /api\.emailit\.com\/v2\/emails\//);
  assert.match(lib, /Authorization: `Bearer \$\{cfg\.api_key\}`/);
  // The webhook-supplied id is constrained before it reshapes the URL.
  assert.match(lib, /\[A-Za-z0-9_-\]\{1,128\}/);
  // Bodies live under body.html / body.text per the v2 response.
  assert.match(lib, /data\?\.body\?\.html/);
  assert.match(lib, /data\?\.body\?\.text/);
});

test('both inbound paths share one recorder that matches the sender and stops reply sequences', async () => {
  const lib = await readFile(new URL('../lib/inbound-email.ts', import.meta.url), 'utf8');
  assert.match(lib, /export async function recordInboundEmail/);
  assert.match(lib, /direction: 'inbound'/);
  assert.match(lib, /email_normalized/);
  assert.match(lib, /stopEnrollmentsFor\(contact\.id, 'reply'\)/);

  // The generic forwarder webhook now delegates to the same recorder.
  const generic = await readFile(
    new URL('../app/api/webhooks/inbound-email/route.ts', import.meta.url),
    'utf8'
  );
  assert.match(generic, /recordInboundEmail/);
  assert.doesNotMatch(generic, /direction: 'inbound'/); // logic moved out, not duplicated
});
