import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  gridToClients,
  mapLinkStatus,
  parseGross,
  parseSignedDate,
} from '../lib/client-import.ts';

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
