import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('the probe-sites API supports full CRUD, admin-gated and validated', async () => {
  const route = await read('../app/api/admin/probe-sites/route.ts');
  // All four verbs, each requiring an admin.
  for (const verb of ['GET', 'POST', 'PATCH', 'DELETE']) {
    assert.match(route, new RegExp(`export async function ${verb}`), `has ${verb}`);
  }
  assert.equal((route.match(/requireAdmin\(\)/g) ?? []).length, 4, 'every verb requires admin');
  // The two NOT NULL columns are validated before an insert/update.
  assert.match(route, /A valid domain is required/);
  assert.match(route, /must be a full http\(s\) URL/);
  assert.match(route, /unsupported placeholder/);
  assert.match(route, /must stay on \$\{domain\}/);
  // A duplicate domain is a 409, not a 500.
  assert.match(route, /error\?\.code === '23505'/);
  assert.match(route, /status: 409/);
  // Delete takes an id from the query string.
  assert.match(route, /searchParams\.get\('id'\)/);
});

test('the Deep Search Sites page can add, edit (incl. templates) and delete', async () => {
  const page = await read('../app/(app)/admin/deep-search-sites/page.tsx');
  assert.match(page, /\+ Add site/);
  assert.match(page, /function openNew/);
  // POST for new, PATCH for existing.
  assert.match(page, /method: f\.id \? 'PATCH' : 'POST'/);
  // Delete calls the DELETE endpoint with the id.
  assert.match(page, /method: 'DELETE'/);
  assert.match(page, /probe-sites\?id=/);
  // The delicate URL templates are now editable, with a warning + placeholder key.
  assert.match(page, /search_template/);
  assert.match(page, /record_url_template/);
  assert.match(page, /date_url_template/);
  assert.match(page, /URL templates are delicate/);
  // The render/browser tier knobs are exposed too.
  assert.match(page, /needs_render/);
  assert.match(page, /needs_browser/);
});
