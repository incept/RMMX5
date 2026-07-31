import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isUnreachableFailure } from '../lib/deep-search/failure-classify.ts';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

// A source that is entirely unreachable (DNS/connection failure) is a transient
// outage of a flaky host, not a fault the operator can fix — so it gets neutral
// wording, a clearer Debug Log line, and a white (not amber) flag.

test('isUnreachableFailure recognizes DNS/connection failures but not read timeouts', () => {
  assert.equal(
    isUnreachableFailure('arrests.org: getaddrinfo ENOTFOUND colorado.arrests.org'),
    true
  );
  assert.equal(isUnreachableFailure('connect ECONNREFUSED 1.2.3.4:443'), true);
  assert.equal(isUnreachableFailure('read ECONNRESET'), true);
  assert.equal(isUnreachableFailure('EHOSTUNREACH 10.0.0.1'), true);
  // A slow page / abort is NOT "unreachable" — a re-run may still help.
  assert.equal(isUnreachableFailure('The operation was aborted due to timeout'), false);
  assert.equal(isUnreachableFailure('unlocker HTTP 403: access denied'), false);
  assert.equal(isUnreachableFailure('empty body'), false);
});

test('the probe-failure log distinguishes an unreachable host from an unreadable page', async () => {
  const lib = await read('../lib/deep-search/fetch-page.ts');
  assert.match(lib, /isUnreachableFailure\(reason\)/);
  assert.match(lib, /host unreachable, likely a temporary outage/);
  assert.match(lib, /could not be read/); // the non-unreachable wording is kept
});

test('an all-unreachable partial run reads neutral, not "run a secondary search"', async () => {
  const lib = await read('../lib/deep-search/index.ts');
  // Only when EVERY failure was unreachability AND the deadline did not also fire.
  assert.match(lib, /unreachable\.length === discoveryFailures\.length && !deadlineHit/);
  assert.match(lib, /Source temporarily unreachable:/);
  assert.match(lib, /clears on its own once the source is back/);
  // The real-partial wording is retained for the mixed / timeout / deadline case.
  assert.match(lib, /confirm them, then run a secondary search/);
});

test('the unreachable flag renders white; the actionable flag stays amber', async () => {
  const panel = await read('../components/ContactPanel.tsx');
  assert.match(panel, /\^Source temporarily unreachable/);
  assert.match(panel, /bg-white/);
  assert.match(panel, /No action needed/);
  assert.match(panel, /bg-amber-50/); // the actionable variant is unchanged

  const grid = await read('../app/(app)/contacts/page.tsx');
  assert.match(grid, /\^Source temporarily unreachable/);
  assert.match(grid, /text-gray-300/);
  assert.match(grid, /text-amber-500/); // the actionable variant is unchanged
});
