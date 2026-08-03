import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Emailit sends pass through a serialized 1-per-2s throttle to stay under the 2/sec cap', async () => {
  const lib = await readFile(new URL('../lib/integrations/emailit.ts', import.meta.url), 'utf8');
  // A serialized, spaced gate.
  assert.match(lib, /function throttleEmailit/);
  assert.match(lib, /EMAILIT_MIN_INTERVAL_MS = 2000/);
  assert.match(lib, /lastEmailitSendAt/);
  // Every send goes through it.
  assert.match(lib, /const send = \(\) =>\s*throttleEmailit\(/);
  assert.match(lib, /api\.emailit\.com\/v2\/emails/);
  // A stray 429 is drained and retried once (already spaced by the throttle),
  // not failed outright.
  assert.match(lib, /res\.status === 429/);
});
