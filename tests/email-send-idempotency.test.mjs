import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

// The single-send route rejects a request without a valid Idempotency-Key, so
// every client compose path must send one. Regression: the contact Email tab
// never did, so every contact send failed with "A valid Idempotency-Key header
// is required".
test('the single-send route requires an Idempotency-Key', async () => {
  const route = await read('../app/api/email/send/route.ts');
  assert.match(route, /A valid Idempotency-Key header is required/);
  assert.match(route, /validIdempotencyKey/);
});

test('every compose surface sends an Idempotency-Key header', async () => {
  const cp = await read('../components/ContactPanel.tsx');
  assert.match(cp, /'Idempotency-Key': requestKey/);
  assert.match(cp, /crypto\.randomUUID\(\)/);

  const inbox = await read('../app/(app)/inbox/page.tsx');
  assert.match(inbox, /'Idempotency-Key': compose\.requestKey/);

  const marketing = await read('../app/(app)/marketing/page.tsx');
  assert.match(marketing, /'Idempotency-Key': blast\.requestKey/);
});
