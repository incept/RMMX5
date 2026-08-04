import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

// Emailit-sent mail is tracked by EMAILIT's native open/click tracking, fed back
// via the email.loaded / email.clicked webhooks — not by our pixel/redirect
// (that instruments SMTP-sent mail). The two must never both instrument the same
// email, or opens/clicks would be double-counted.

test('sendViaEmailit enables native tracking and stamps the row id as meta', async () => {
  const lib = await read('../lib/integrations/emailit.ts');
  assert.match(lib, /messageRowId\?: string/);
  // Per-send override of the domain default — no dashboard change needed to turn
  // tracking on.
  assert.match(lib, /tracking: \{ loads: true, clicks: true \}/);
  // The row id is attached as meta so the webhooks map back to the exact message.
  assert.match(lib, /meta: \{ message_row_id: opts\.messageRowId \}/);
});

test('the two transports carry different bodies so tracking never double-counts', async () => {
  const send = await read('../lib/email-send.ts');
  // SMTP body is self-instrumented (pixel + click redirect); Emailit body is clean.
  assert.match(send, /const smtpHtml =/);
  assert.match(send, /const emailitHtml = cleanHtml \+ signature/);
  // SMTP transport uses the instrumented body...
  assert.match(send, /html: smtpHtml/);
  // ...and Emailit uses the clean body + turns on its native tracking via messageRowId.
  assert.match(send, /html: emailitHtml/);
  assert.match(send, /messageRowId: row\.id/);
  // The Emailit body must NOT carry our open pixel.
  assert.doesNotMatch(send, /emailitHtml[^\n]*api\/track\/open/);
});

test('the Emailit webhook records email.loaded/clicked into the shared counter', async () => {
  const route = await read('../app/api/webhooks/emailit/route.ts');
  assert.match(route, /email\.loaded/);
  assert.match(route, /email\.clicked/);
  // Maps by exact message identifiers only; recipient guesses can misattribute delayed events.
  assert.match(route, /emailObj\?\.meta\?\.message_row_id/);
  assert.match(route, /provider_message_id/);
  assert.doesNotMatch(route, /ilike\('email'/);
  // Same atomic bounded counter the /api/track pixel uses (so open_count /
  // click_count / email_events all update identically), and the click url is
  // recorded.
  assert.match(route, /track_email_event_and_stop/);
  assert.match(route, /p_event: isClick \? 'click' : 'open'/);
  assert.match(route, /object\?\.link\?\.url/);
  // Open/click still stops sequences configured to stop on engagement.
  assert.doesNotMatch(route, /stopEnrollmentsFor\(stopContact/);
  // De-duplicated on the event id, like the other Emailit events.
  assert.match(route, /claimWebhookReceipt\('emailit', engagementEventId\)/);
});
