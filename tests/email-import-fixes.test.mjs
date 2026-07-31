import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('email delivery falls back to Emailit when SMTP fails, not only when SMTP is absent', async () => {
  const send = await readFile(new URL('../lib/email-send.ts', import.meta.url), 'utf8');
  // SMTP runs in its own try/catch; a shared fallback then runs whenever !ok.
  assert.match(send, /if \(account\?\.smtp_host\) \{/);
  assert.match(send, /if \(!ok\) \{[\s\S]*?sendViaEmailit/);
  // The fallback records the SMTP failure and surfaces both reasons if it also
  // fails downstream.
  assert.match(send, /falling back to Emailit/);
  assert.match(send, /\[smtpError, r\.error\]/);
});

test('import audit log uses a plain insert so the partial unique index does not break ON CONFLICT', async () => {
  const contact = await readFile(new URL('../app/api/import/route.ts', import.meta.url), 'utf8');
  const client = await readFile(new URL('../app/api/import/clients/route.ts', import.meta.url), 'utf8');
  for (const route of [contact, client]) {
    assert.match(route, /from\('imports'\)\.insert\(\{/);
    assert.doesNotMatch(route, /onConflict: 'request_key'/);
    // A duplicate key (idempotent re-run) is ignored; other errors are not.
    assert.match(route, /logError\.code !== '23505'/);
  }
});
