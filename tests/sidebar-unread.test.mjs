import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('the sidebar flags unread inbox mail with a live badge', async () => {
  const sidebar = await read('../components/Sidebar.tsx');
  // Counts unread inbound messages (not the ones already read or hidden).
  assert.match(sidebar, /direction', 'inbound'/);
  assert.match(sidebar, /'seen', false/);
  assert.match(sidebar, /\.is\('hidden_at', null\)/);
  // Kept live: a new message bumps it, reading one (seen -> true) drops it.
  assert.match(sidebar, /useRealtimeRefresh\('email_messages', loadUnread\)/);
  assert.match(sidebar, /useAutoRefresh\(loadUnread/);
  // Rendered as a badge on the Inbox item, and a dot on a collapsed Messaging.
  assert.match(sidebar, /item\.href === '\/inbox' \? unread : 0/);
  assert.match(sidebar, /section\.id === 'outreach' && unread > 0/);
});
