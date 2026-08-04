import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseImportDate } from '../lib/import-date.ts';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('parseImportDate handles common sheet formats and rejects junk', () => {
  assert.equal(parseImportDate(''), null);
  assert.equal(parseImportDate('   '), null);
  assert.equal(parseImportDate('not a date'), null);
  assert.equal(parseImportDate(null), null);
  // ISO date-only is UTC midnight — deterministic regardless of the test's tz.
  assert.equal(parseImportDate('2024-11-28'), '2024-11-28T00:00:00.000Z');
  assert.equal(parseImportDate('  2024-11-28  '), '2024-11-28T00:00:00.000Z');
  // US locale (a Monday export) parses to a real 2024 date.
  assert.ok(parseImportDate('11/28/2024')?.startsWith('2024-'));
  assert.equal(parseImportDate('03/04/2024'), null); // locale-ambiguous
  assert.equal(parseImportDate('31/12/2024'), null); // never guess DD/MM
  assert.equal(parseImportDate('02/31/2024'), null); // reject Date overflow
  assert.equal(parseImportDate('2024-02-31'), null);
  // Out-of-window mis-parses are dropped so the row keeps a sane created_at.
  assert.equal(parseImportDate('3000-01-01'), null);
  assert.equal(parseImportDate('1850-01-01'), null);
});

test('the wizard offers a Date created target and auto-detects date headers', async () => {
  const lib = await read('../lib/monday-import.ts');
  assert.match(lib, /key: 'created_at', label: 'Date created'/);
  assert.match(lib, /created_at: \[/);
  assert.match(lib, /'datecreated'/);
});

test('the import route parses the mapped date (null when blank/invalid)', async () => {
  const route = await read('../app/api/import/route.ts');
  assert.match(route, /import \{ parseImportDate \} from '@\/lib\/import-date'/);
  assert.match(route, /created_at: parseImportDate\(row\.created_at\)/);
});

test('migration 0053 stores the mapped date, falling back to now()', async () => {
  const sql = await read('../supabase/migrations/0053_import_created_at.sql');
  // created_at added to the contacts insert column list...
  assert.match(sql, /utm, created_at/);
  // ...and defaulted to now() when the row carries no valid date.
  assert.match(sql, /coalesce\(nullif\(v_row->>'created_at', ''\)::timestamptz, now\(\)\)/);
});
