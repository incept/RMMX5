import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

// #2: every CRM email carries an Emailit-inbound Reply-To so recipient replies
// route back into the CRM inbox instead of the raw From mailbox.

test('Emailit sends default Reply-To to the configured inbound reply address', async () => {
  const lib = await read('../lib/integrations/emailit.ts');
  assert.match(lib, /inbound_reply_address\?: string/);
  // An explicit replyTo wins; otherwise fall back to the configured address.
  assert.match(lib, /const replyTo = opts\.replyTo \|\| cfg\.inbound_reply_address/);
  assert.match(lib, /reply_to: replyTo/);
});

test('sendCrmEmail sets Reply-To on both the SMTP and Emailit paths', async () => {
  const lib = await read('../lib/email-send.ts');
  assert.match(lib, /getSetting<\{[\s\S]*?inbound_reply_address\?: string[\s\S]*?\}>\('emailit'\)/);
  // SMTP transport carries replyTo when set; the Emailit fallback is passed it too.
  assert.match(lib, /\.\.\.\(replyTo \? \{ replyTo \} : \{\}\)/);
  assert.match(lib, /const r = await sendViaEmailit\(\{[\s\S]*?replyTo,[\s\S]*?\}\)/);
});

test('the integrations page exposes the inbound reply-to address field', async () => {
  const page = await read('../app/(app)/admin/integrations/page.tsx');
  assert.match(page, /key: 'inbound_reply_address'/);
  assert.match(page, /Inbound reply-to address/);
});
