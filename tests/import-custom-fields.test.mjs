import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { customFieldTargets, suggestMapping } from '../lib/monday-import.ts';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('customFieldTargets namespaces every custom field and drops keyless rows', () => {
  const targets = customFieldTargets([
    { field_key: 'os', label: 'OS' },
    { field_key: 'link_status', label: 'Link status' },
    { field_key: '', label: 'no key yet' },
  ]);
  // "custom:" prefix keeps a custom field from colliding with a built-in target
  // of the same name (the built-in "Link Status" sets each link's state).
  assert.deepEqual(targets, [
    { key: 'custom:os', label: 'OS (custom)' },
    { key: 'custom:link_status', label: 'Link status (custom)' },
  ]);
});

test('suggestMapping auto-maps a header onto a custom field by label or key', () => {
  const byLabel = suggestMapping(['Name', 'OS'], [{ field_key: 'os', label: 'OS' }]);
  assert.equal(byLabel['Name'], 'name'); // built-ins still win
  assert.equal(byLabel['OS'], 'custom:os');

  const byKey = suggestMapping(
    ['operating_system'],
    [{ field_key: 'operating_system', label: 'Device OS' }]
  );
  assert.equal(byKey['operating_system'], 'custom:operating_system');

  // Unknown headers and the no-custom-fields case leave nothing dangling.
  assert.equal(suggestMapping(['Mystery'], [{ field_key: 'os', label: 'OS' }])['Mystery'], undefined);
  assert.equal(suggestMapping(['Email'])['Email'], 'email');
});

test('the import wizard fetches custom fields and offers them as targets', async () => {
  const page = await read('../app/(app)/import/page.tsx');
  assert.match(page, /from\('custom_fields'\)/);
  assert.match(page, /customFieldTargets/);
  assert.match(page, /suggestMapping\(parsed\.headers, customFields\)/);
  assert.match(page, /optgroup label="Custom fields"/);
});

test('the import route stores only known custom fields onto contacts.custom', async () => {
  const route = await read('../app/api/import/route.ts');
  assert.match(route, /const customKeys = new Set/); // valid keys, fetched once
  assert.match(route, /startsWith\('custom:'\)/);
  assert.match(route, /customKeys\.has\(fieldKey\)/); // stale/forged keys ignored
  assert.match(route, /custom\[fieldKey\] = cleaned/);
});

test('migration 0055 persists custom into the contacts insert', async () => {
  const sql = await read('../supabase/migrations/0055_import_custom_fields.sql');
  assert.match(sql, /utm, created_at, custom/); // custom added to the column list
  assert.match(sql, /coalesce\(v_row->'custom', '\{\}'::jsonb\)/); // {} when a row maps none
});
