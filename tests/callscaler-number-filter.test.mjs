import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  normalizeCallNumber,
  parseAllowedNumbers,
  isTrackingNumberAllowed,
} from '../lib/callscaler-filter.ts';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('normalizeCallNumber reduces any format to the last 10 digits', () => {
  assert.equal(normalizeCallNumber('18134218334'), '8134218334');
  assert.equal(normalizeCallNumber('+1 (813) 421-8334'), '8134218334');
  assert.equal(normalizeCallNumber('813-421-8334'), '8134218334');
  assert.equal(normalizeCallNumber('8446847468'), '8446847468'); // already 10 digits
  assert.equal(normalizeCallNumber('123'), null); // too short
  assert.equal(normalizeCallNumber(''), null);
  assert.equal(normalizeCallNumber(null), null);
});

test('parseAllowedNumbers separates on commas/newlines, keeps in-number formatting', () => {
  const set = parseAllowedNumbers('18134218334, 18446847468');
  assert.deepEqual([...set].sort(), ['8134218334', '8446847468']);
  // One number per line, each with internal spaces/dashes/parens/+1 — each line
  // stays a single number rather than shattering on its spaces.
  const set2 = parseAllowedNumbers('+1 813 421 8334\n(844) 684-7468');
  assert.deepEqual([...set2].sort(), ['8134218334', '8446847468']);
});

test('parseAllowedNumbers treats blank / junk as no filter', () => {
  assert.equal(parseAllowedNumbers('').size, 0);
  assert.equal(parseAllowedNumbers('   ').size, 0);
  assert.equal(parseAllowedNumbers('n/a').size, 0);
  assert.equal(parseAllowedNumbers(null).size, 0);
  assert.equal(parseAllowedNumbers(undefined).size, 0);
});

test('isTrackingNumberAllowed: an empty allowlist admits every call (default)', () => {
  const none = new Set();
  assert.equal(isTrackingNumberAllowed('18134218334', none), true);
  assert.equal(isTrackingNumberAllowed(null, none), true);
});

test('isTrackingNumberAllowed: a set allowlist admits only listed numbers', () => {
  const allow = parseAllowedNumbers('18134218334, 18446847468');
  assert.equal(isTrackingNumberAllowed('+18134218334', allow), true); // listed, +country code
  assert.equal(isTrackingNumberAllowed('(844) 684-7468', allow), true); // listed toll-free
  assert.equal(isTrackingNumberAllowed('19998887777', allow), false); // not listed
  assert.equal(isTrackingNumberAllowed(null, allow), false); // no tracking number on the call
});

test('processCallScalerCall enforces the allowlist before importing anything', async () => {
  const src = await read('../lib/integrations/callscaler.ts');
  assert.match(src, /parseAllowedNumbers/);
  assert.match(src, /isTrackingNumberAllowed/);
  assert.match(src, /allowed_tracking_numbers/);
  assert.match(src, /number_not_allowed/);
  // The gate must return BEFORE the calls upsert, so a disallowed call never
  // lands in the calls table or creates a contact.
  const gateIdx = src.indexOf('number_not_allowed');
  const upsertIdx = src.indexOf("from('calls').upsert");
  assert.ok(gateIdx > 0 && upsertIdx > 0 && gateIdx < upsertIdx, 'gate precedes the calls insert');
});

test('the admin CallScaler section exposes the allowlist field', async () => {
  const page = await read('../app/(app)/admin/integrations/page.tsx');
  assert.match(page, /allowed_tracking_numbers/);
});
