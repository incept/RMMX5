import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeImportUrl } from '../lib/import-url.ts';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('normalizeImportUrl keeps valid http(s) and trims', () => {
  assert.equal(normalizeImportUrl('https://example.com/records/1'), 'https://example.com/records/1');
  assert.equal(normalizeImportUrl('  https://foo.com  '), 'https://foo.com');
  assert.equal(normalizeImportUrl('http://bar.org/x?y=1'), 'http://bar.org/x?y=1');
});

test('normalizeImportUrl assumes https for a scheme-less host (the common Monday case)', () => {
  assert.equal(normalizeImportUrl('example.com'), 'https://example.com');
  assert.equal(normalizeImportUrl('www.site.org/records/1'), 'https://www.site.org/records/1');
});

test('normalizeImportUrl rejects junk, other schemes, and blanks (caller skips them)', () => {
  for (const junk of [
    '',
    '   ',
    'N/A',            // no dot
    'none',           // no dot
    'see the notes',  // whitespace
    'localhost',      // no dot — never guess a bare host
    'mailto:a@b.com',
    'tel:+15551234567',
    'javascript:alert(1)',
    'ftp://files.example.com',
    null,
    undefined,
  ]) {
    assert.equal(normalizeImportUrl(junk), null, JSON.stringify(junk));
  }
});

test('the import route skips bad link cells and reports them instead of a 400', async () => {
  const route = await read('../app/api/import/route.ts');
  assert.match(route, /import \{ normalizeImportUrl \} from '@\/lib\/import-url'/);
  assert.match(route, /normalizeImportUrl\(raw\)/);
  assert.match(route, /skippedLinks\.push/);
  // The all-or-nothing hard failure is gone.
  assert.doesNotMatch(route, /only HTTP\(S\) URLs are allowed/);
  assert.match(route, /warnings: skippedLinks\.slice/);
  assert.match(route, /skippedLinkCount: skippedLinks\.length/);
});

test('the wizard surfaces skipped-link warnings without blocking the import', async () => {
  const page = await read('../app/(app)/import/page.tsx');
  assert.match(page, /result\.skippedLinkCount/);
  assert.match(page, /result\.warnings\.map/);
  assert.match(page, /the contacts still imported/);
});
