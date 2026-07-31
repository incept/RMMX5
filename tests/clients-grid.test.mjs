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
  // Link Stats is a derived column: reorderable but not sortable (no sortKey).
  assert.match(page, /linkstats: \{[\s\S]*?headerTitle:/);
});

test('the clients API sorts on a whitelist, searches safely, and counts the filtered set', async () => {
  const route = await readFile(new URL('../app/api/clients/route.ts', import.meta.url), 'utf8');
  assert.match(route, /const SORT_COLUMNS/);
  assert.match(route, /gross_revenue: \{ col: 'gross_revenue', adminOnly: true \}/);
  assert.match(route, /isAdmin \|\| !chosen\.adminOnly/);
  // Search term sanitised before the .or() filter; filtered exact count; stable order.
  assert.match(route, /\.replace\(\/\[,\(\)/);
  assert.match(route, /name\.ilike\.%\$\{q\}%/);
  assert.match(route, /count: 'exact'/);
  assert.match(route, /\.order\('id', \{ ascending: true \}\)/);
  // Still embeds link statuses for the Link Stats column.
  assert.match(route, /contact_links \( status \)/);
});

test('the Link Data status sits under the URL, not in a shared flex row', async () => {
  const panel = await readFile(new URL('../components/ContactPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /Removal status sits UNDER/);
  // The URL input can shrink; the status select no longer uses the .input w-32
  // that ballooned it (the Statuses & Stages cascade bug).
  assert.match(panel, /className="input min-w-0 flex-1"/);
  assert.doesNotMatch(panel, /className="input w-32"/);
});
