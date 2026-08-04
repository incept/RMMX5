import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('the contacts grid offers a selectable page size within the RPC cap', async () => {
  const page = await read('../app/(app)/contacts/page.tsx');
  // Options stay within contacts_grid_page's server clamp of 200.
  assert.match(page, /PAGE_SIZE_OPTIONS = \[50, 100, 200\]/);
  assert.match(page, /const \[pageSize, setPageSize\] = useState/);
  // The chosen size drives the fetch, the count math, and resets to page 1.
  assert.match(page, /p_page_size: pageSize/);
  assert.match(page, /Math\.ceil\(total \/ pageSize\)/);
  assert.match(page, /setPage\(0\), \[view, statusFilter, search, sortKey, sortAsc, pageSize\]/);
});

test('the bulk bar can add selected contacts to a list or a sequence', async () => {
  const page = await read('../app/(app)/contacts/page.tsx');
  assert.match(page, /async function bulkAddToList/);
  assert.match(page, /\/api\/email\/lists\/\$\{listId\}\/members/);
  assert.match(page, /async function bulkEnroll/);
  assert.match(page, /\/api\/email\/sequences\/\$\{sequenceId\}\/enroll/);
  // Both post the current selection, admin-gated in the bar.
  assert.match(page, /contactIds: ids/);
  assert.match(page, /isAdmin && lists\.length > 0/);
  assert.match(page, /isAdmin && sequences\.length > 0/);
});

test('the list-add endpoint is admin-only and de-dups membership', async () => {
  const route = await read('../app/api/email/lists/[id]/members/route.ts');
  assert.match(route, /requireAdmin/);
  assert.match(route, /contactIds must be a non-empty array/);
  assert.match(route, /MAX_BULK_RECIPIENTS/);
  // Only the not-yet-members are inserted, so a re-add is a clean no-op.
  assert.match(route, /\.in\('contact_id', ids\)/);
  assert.match(route, /toAdd\.map\(\(contact_id\) => \(\{ list_id: id, contact_id \}\)\)/);
});
