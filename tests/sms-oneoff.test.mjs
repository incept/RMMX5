import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { smsSegmentInfo } from '../lib/sms-format.ts';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('smsSegmentInfo counts GSM-7 single and multi-segment bodies', () => {
  assert.deepEqual(smsSegmentInfo(''), { chars: 0, segments: 0, encoding: 'GSM' });
  assert.deepEqual(smsSegmentInfo('Hi there'), { chars: 8, segments: 1, encoding: 'GSM' });
  assert.equal(smsSegmentInfo('a'.repeat(160)).segments, 1); // 160 fits one segment
  assert.equal(smsSegmentInfo('a'.repeat(161)).segments, 2); // spills to 153-char parts
  assert.equal(smsSegmentInfo('a'.repeat(306)).segments, 2); // 2 * 153
  assert.equal(smsSegmentInfo('a'.repeat(307)).segments, 3);
});

test('smsSegmentInfo switches to UCS-2 for non-GSM characters', () => {
  assert.equal(smsSegmentInfo('Hi 👋').encoding, 'UCS2');
  assert.equal(smsSegmentInfo('Hi 👋').chars, 4); // code points, emoji counts once
  assert.equal(smsSegmentInfo('😀'.repeat(35)).segments, 1); // 70 UTF-16 units
  assert.equal(smsSegmentInfo('😀'.repeat(36)).segments, 2); // 72 units -> 2 segments
});

test('smsSegmentInfo treats GSM extension characters as two septets', () => {
  const info = smsSegmentInfo('€'.repeat(81)); // 81 * 2 = 162 septets
  assert.equal(info.encoding, 'GSM');
  assert.equal(info.chars, 81);
  assert.equal(info.segments, 2);
});

test('the one-off SMS route sends synchronously, admin-only, with placeholders', async () => {
  const route = await read('../app/api/contacts/[id]/sms/route.ts');
  assert.match(route, /requireAdmin/); // billed action, admin-gated like one-off email
  assert.match(route, /renderTemplate\(rawBody, enriched\)/); // {{placeholders}} rendered (link-enriched)
  assert.match(route, /from\('sms_messages'\)/); // recorded for history
  assert.match(route, /sendSms\(/); // actually delivers (synchronous)
  assert.match(route, /logActivity/); // mirrored to the contact timeline
  assert.match(route, /delivery_key/); // idempotent against double-submit
});

test('the contact panel exposes an SMS tab wired to the route', async () => {
  const panel = await read('../components/ContactPanel.tsx');
  assert.match(panel, /'Email', 'SMS', 'Calls'/); // new tab in the tab bar
  assert.match(panel, /\/api\/contacts\/\$\{contactId\}\/sms/); // posts to the send route
  assert.match(panel, /insertSmsPlaceholder/); // one-click placeholder insert
  assert.match(panel, /renderTemplate\(smsBody,/); // live per-contact preview
  assert.match(panel, /smsSegmentInfo/); // character/segment counter
});
