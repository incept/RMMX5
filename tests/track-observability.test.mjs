import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

// A tracking hit whose HMAC does not verify used to be dropped in silence, so a
// CRON_SECRET mismatch between the host that signed the link and the host
// verifying it made opens/clicks read as zero with nothing in the log. These
// endpoints now log that case so the mismatch is diagnosable.

test('signing exposes whether a tracking secret is configured', async () => {
  const signing = await read('../lib/signing.ts');
  assert.match(signing, /export function trackingSecretConfigured/);
});

test('the open pixel logs a signature-verification failure instead of dropping it silently', async () => {
  const open = await read('../app/api/track/open/route.ts');
  assert.match(open, /trackingSecretConfigured/);
  assert.match(open, /signature did not verify/);
  // The failure records whether the secret is even present, to tell "no secret"
  // apart from "secret present but mismatched".
  assert.match(open, /secretConfigured: trackingSecretConfigured\(\)/);
  // A recipient still gets their pixel on a signature failure.
  assert.match(open, /return pixelResponse\(\);/);
});

test('the click endpoint logs a signature-verification failure and still withholds the redirect', async () => {
  const click = await read('../app/api/track/click/route.ts');
  assert.match(click, /trackingSecretConfigured/);
  assert.match(click, /signature did not verify/);
  // Unsigned / mismatched clicks must never redirect to the target (open-redirect
  // guard) — they still bounce to the app root.
  assert.match(click, /new URL\('\/', request\.url\)/);
});
