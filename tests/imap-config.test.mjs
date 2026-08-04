import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('0043 adds IMAP config and never exposes imap_password', async () => {
  const m = await read('../supabase/migrations/0043_imap_config.sql');
  assert.match(m, /add column if not exists imap_host text/);
  assert.match(m, /add column if not exists imap_password text/);
  assert.match(m, /add column if not exists imap_enabled boolean/);
  assert.match(m, /security_invoker = true/); // view still respects RLS

  // The safe view exposes non-secret IMAP fields, never the password.
  const view = m.slice(
    m.indexOf('create or replace view public.email_accounts_safe as'),
    m.indexOf('from public.email_accounts')
  );
  assert.match(view, /imap_host/);
  assert.doesNotMatch(view, /imap_password/);

  // Same for the column grant to authenticated.
  const grant = m.slice(
    m.indexOf('grant select ('),
    m.indexOf(') on public.email_accounts to authenticated')
  );
  assert.match(grant, /imap_host/);
  assert.doesNotMatch(grant, /imap_password/);
  assert.doesNotMatch(grant, /smtp_password/);
});

test('the IMAP connection test is admin-gated and runs on Node', async () => {
  const route = await read('../app/api/admin/email-accounts/test-imap/route.ts');
  assert.match(route, /requireAdmin/);
  assert.match(route, /runtime = 'nodejs'/);
  assert.match(route, /new ImapFlow/);
  assert.match(route, /ok: false/); // a failed login is a result, not a 500
});

test('admin account routes accept and validate IMAP fields', async () => {
  const create = await read('../app/api/admin/email-accounts/route.ts');
  const update = await read('../app/api/admin/email-accounts/[id]/route.ts');
  for (const src of [create, update]) {
    assert.match(src, /values\.imap_host/);
    assert.match(src, /values\.imap_enabled/);
    assert.match(src, /IMAP port must be between 1 and 65535/);
  }
});

test('0044 adds the cert-trust flag and the connection honors it (opt-in)', async () => {
  const m = await read('../supabase/migrations/0044_imap_cert_trust.sql');
  assert.match(m, /add column if not exists imap_allow_invalid_cert boolean not null default false/);
  assert.match(m, /imap_allow_invalid_cert/); // joins the safe view + grant

  // The test connection relaxes TLS verification only when the flag is set.
  const route = await read('../app/api/admin/email-accounts/test-imap/route.ts');
  assert.match(route, /imap_allow_invalid_cert/);
  assert.match(route, /rejectUnauthorized: !allowInvalidCert/);
  assert.match(route, /servername: target\.servername/);

  const create = await read('../app/api/admin/email-accounts/route.ts');
  const update = await read('../app/api/admin/email-accounts/[id]/route.ts');
  for (const src of [create, update]) {
    assert.match(src, /values\.imap_allow_invalid_cert/);
  }
});
