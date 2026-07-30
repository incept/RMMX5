import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  gridToClients,
  mapLinkStatus,
  parseGross,
  parseSignedDate,
} from '../lib/client-import.ts';
import { isValidISODate } from '../lib/valid-date.ts';

test('gridToClients groups a fill-down roster into clients with their links', () => {
  const grid = [
    ['Date', 'Client', 'State', 'Gross ', 'Status', 'Website'],
    ['2026-07-16', 'Jeffery Remmark', 'VA', '789.99', 'Requested', 'https://a.com/x'],
    ['', '', '', '', 'Removed', 'https://b.com/y'],
    ['', '', '', '', 'Live', 'https://c.com/z'],
    ['6/29/26/', 'Milen Santiano', 'FL', '1695.99', 'Removed', 'https://d.com/1'],
  ];
  const res = gridToClients(grid);
  assert.equal(res.clients.length, 2);
  const [a, b] = res.clients;
  assert.equal(a.name, 'Jeffery Remmark');
  assert.equal(a.state, 'VA');
  assert.equal(a.grossRevenue, 789.99);
  assert.equal(a.signedDate, '2026-07-16');
  // The client identity fills down: the leader row plus its two blank-name rows.
  assert.equal(a.links.length, 3);
  assert.deepEqual(a.links.map((l) => l.status), ['requested', 'removed', 'live']);
  assert.equal(b.name, 'Milen Santiano');
  assert.equal(b.signedDate, '2026-06-29'); // trailing-slash date tolerated
  assert.equal(b.links.length, 1);
  assert.equal(res.totalLinks, 4);
});

test('gridToClients caps links at 14 and reports the overflow', () => {
  const rows = [['Big Client', 'https://x.com/0']];
  for (let i = 1; i < 20; i++) rows.push(['', `https://x.com/${i}`]);
  const res = gridToClients([['Client', 'Website'], ...rows]);
  assert.equal(res.clients[0].links.length, 14);
  assert.equal(res.clients[0].droppedLinks, 6);
  assert.equal(res.droppedLinks, 6);
  assert.deepEqual(res.overCapClients, ['Big Client']);
});

test('gridToClients flags suspicious names but still imports them', () => {
  const res = gridToClients([
    ['Client', 'Website'],
    ['ontherun@gmail.com', 'https://a.com/x'],
    ['s', 'https://b.com/y'],
    ['Real Person', 'https://c.com/z'],
  ]);
  assert.equal(res.clients.length, 3);
  assert.deepEqual(res.suspiciousNames, ['ontherun@gmail.com', 's']);
});

test('gridToClients accepts a "Name" header too (roster renamed in Excel)', () => {
  const res = gridToClients([['Name', 'Website'], ['Jane Doe', 'https://a.com/x']]);
  assert.equal(res.clients[0].name, 'Jane Doe');
});

test('gridToClients dedupes a repeated URL within one client', () => {
  const res = gridToClients([
    ['Client', 'Website'],
    ['Jane Doe', 'https://a.com/x'],
    ['', 'https://a.com/x'],
  ]);
  assert.equal(res.clients[0].links.length, 1);
});

test('gridToClients counts non-URL website cells instead of losing them silently', () => {
  const res = gridToClients([
    ['Client', 'Website'],
    ['Jane Doe', 'https://a.com/x'],
    ['', 'see notes — removed by phone'],
    ['', 'recentlybooked.com/no-scheme'],
  ]);
  assert.equal(res.clients[0].links.length, 1);
  assert.equal(res.skippedInvalidUrls, 2);
});

test('link status maps roster labels to the three CRM states', () => {
  assert.equal(mapLinkStatus('Removed'), 'removed');
  assert.equal(mapLinkStatus('Site Is Down'), 'removed');
  assert.equal(mapLinkStatus('Live'), 'live');
  assert.equal(mapLinkStatus('Requested'), 'requested');
  assert.equal(mapLinkStatus('DMCA'), 'requested');
  assert.equal(mapLinkStatus('Refund'), 'live'); // unknown -> presumed still up
  assert.equal(mapLinkStatus(''), 'live');
});

test('gross and signed-date parsing tolerate messy cells', () => {
  assert.equal(parseGross('$1,695.99'), 1695.99);
  assert.equal(parseGross(''), null);
  assert.equal(parseGross('abc'), null);
  assert.equal(parseSignedDate('2025-06-03'), '2025-06-03');
  assert.equal(parseSignedDate('6/29/26/'), '2026-06-29');
  assert.equal(parseSignedDate(''), null);
  assert.equal(parseSignedDate('not a date'), null);
});

test('isValidISODate rejects impossible calendar dates a regex would accept', () => {
  assert.equal(isValidISODate('2025-06-03'), true);
  assert.equal(isValidISODate('2026-02-31'), false);
  assert.equal(isValidISODate('2026-99-99'), false);
  assert.equal(isValidISODate('2026-13-01'), false);
  assert.equal(isValidISODate('2026-00-10'), false);
  assert.equal(isValidISODate('2026-2-3'), false); // must be zero-padded
  assert.equal(isValidISODate('2026-02-29'), false); // 2026 is not a leap year
  assert.equal(isValidISODate('2024-02-29'), true); // 2024 is
});

test('parseSignedDate nulls an impossible ISO date instead of passing it to the DB', () => {
  // Would otherwise reach a ::date cast and abort a mid-import chunk.
  assert.equal(parseSignedDate('2026-02-31'), null);
  assert.equal(parseSignedDate('2026-99-99 notes'), null);
  assert.equal(parseSignedDate('2025-06-03'), '2025-06-03');
});

test('gridToClients reports no CSV errors (that layer is CSV-parse only)', () => {
  const res = gridToClients([['Client', 'Website'], ['Jane', 'https://a.com/x']]);
  assert.deepEqual(res.csvErrors, []);
});

test('migration 0035 adds the client fields and the idempotent import RPC', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/0035_client_import.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration, /add column if not exists gross_revenue numeric/);
  assert.match(migration, /add column if not exists signed_date date/);
  assert.match(migration, /function public\.import_client_chunk/);
  assert.match(migration, /grant execute on function public\.import_client_chunk\(text, jsonb, uuid\) to service_role/);
});

test('the client import route is admin-only and stamps the client status', async () => {
  const route = await readFile(
    new URL('../app/api/import/clients/route.ts', import.meta.url),
    'utf8'
  );
  assert.match(route, /requireAdmin/);
  assert.match(route, /is_client_status/);
  assert.match(route, /import_client_chunk/);
  assert.match(route, /idempotency-key/i);
});

test('the client import route validates the destination status and never guesses among many', async () => {
  const route = await readFile(
    new URL('../app/api/import/clients/route.ts', import.meta.url),
    'utf8'
  );
  // An explicit wizard choice is checked against the client-status set…
  assert.match(route, /body\.statusId/);
  assert.match(route, /not a client status/);
  // …and with several flagged and none named "Client", it refuses rather than
  // silently misfiling hundreds of rows into an arbitrary lifecycle status.
  assert.match(route, /Several client statuses exist/);
  // Real calendar dates only reach the DB.
  assert.match(route, /isValidISODate\(signed\)/);
});

test('the import wizard derives a stable idempotency key from the payload', async () => {
  const page = await readFile(
    new URL('../app/(app)/import/clients/page.tsx', import.meta.url),
    'utf8'
  );
  // Not a fresh random UUID per selection — a content hash, so a reload + reselect
  // of the same file reuses the key and cannot duplicate committed clients.
  assert.match(page, /hashKey\(payload\)/);
  assert.doesNotMatch(page, /crypto\.randomUUID\(\)/);
  // And it preflights the body size against the server limit.
  assert.match(page, /MAX_IMPORT_BODY_BYTES/);
});

test('gross revenue is admin-only across the contact API, like revenue_projection', async () => {
  const route = await readFile(
    new URL('../app/api/contacts/[id]/route.ts', import.meta.url),
    'utf8'
  );
  // Stripped from BOTH non-admin reads (GET, and the read-back after PATCH)…
  assert.equal(route.match(/delete \(\w+ as Record<string, any>\)\.gross_revenue;/g)?.length, 2);
  // …and a non-admin write is refused, not applied.
  assert.match(route, /Only an admin can set gross revenue/);
  // The panel only renders the field where saving can work.
  const panel = await readFile(new URL('../components/ContactPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /\{isAdmin && \(\s*<div>\s*<label className="label">Gross revenue<\/label>/);
});
