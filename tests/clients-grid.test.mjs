import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('the clients grid has draggable, click-to-sort columns and a search box', async () => {
  const page = await readFile(new URL('../app/(app)/clients/page.tsx', import.meta.url), 'utf8');
  // Column reorder — the same mechanism as the contacts grid.
  assert.match(page, /draggable/);
  assert.match(page, /function moveCol/);
  assert.match(page, /localStorage\.setItem\(COLS_LS/);
  // Click-to-sort, driven server-side via the sort/dir params.
  assert.match(page, /function toggleSort/);
  assert.match(page, /page: String\(page\), sort, dir/);
  // Debounced search wired to the q param.
  assert.match(page, /placeholder="Search name, email, or phone/i);
  assert.match(page, /setTimeout\(\(\) => setDebouncedSearch/);
  assert.match(page, /params\.set\('q', debouncedSearch/);
});

test('the clients API sorts on a whitelist, searches safely, and counts the filtered set', async () => {
  const route = await readFile(new URL('../app/api/clients/route.ts', import.meta.url), 'utf8');
  // Sort is whitelisted; admin-only columns fall back to the default for non-admins.
  assert.match(route, /const SORT_COLUMNS/);
  assert.match(route, /adminOnly: true/);
  assert.match(route, /isAdmin \|\| !chosen\.adminOnly/);
  // The search term is sanitised before entering the .or() filter string.
  assert.match(route, /\.replace\(\/\[,\(\)/);
  assert.match(route, /name\.ilike\.%\$\{q\}%/);
  // A (search-)filtered exact count drives pagination; a stable tiebreaker keeps
  // pages from shuffling on ties.
  assert.match(route, /count: 'exact'/);
  assert.match(route, /\.order\('id', \{ ascending: true \}\)/);
});
