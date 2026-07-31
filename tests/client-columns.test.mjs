import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('the clients grid drops Rep Score / Projected Revenue and shows coloured Link Stats', async () => {
  const page = await readFile(new URL('../app/(app)/clients/page.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /Rep Score/);
  assert.doesNotMatch(page, /Projected Revenue/);
  assert.match(page, /Link Stats/);
  // Each count is coloured by status: Live red, Requested orange, Removed green.
  assert.match(page, /'live', color: '#EF4444'/);
  assert.match(page, /'requested', color: '#F59E0B'/);
  assert.match(page, /'removed', color: '#22C55E'/);
  // Gross stays as an admin-only column in the grid config.
  assert.match(page, /gross: \{[\s\S]*?adminOnly: true/);
});

test('the clients API embeds link statuses and no longer selects revenue_projection', async () => {
  const route = await readFile(new URL('../app/api/clients/route.ts', import.meta.url), 'utf8');
  assert.match(route, /contact_links \( status \)/);
  assert.doesNotMatch(route, /revenue_projection/);
  assert.match(route, /gross_revenue/); // still selected for admins
});

test('the service countdown lives in Link Data with an editable 3-digit days-left field', async () => {
  const panel = await readFile(new URL('../components/ContactPanel.tsx', import.meta.url), 'utf8');
  // Editing days-left commits a fresh N-day countdown from today…
  assert.match(panel, /function commitDaysLeft/);
  assert.match(panel, /client_since: new Date\(\)\.toISOString\(\), service_days: v/);
  // …bounded to a 3-digit integer.
  assert.match(panel, /v < 0 \|\| v > 999/);
  // The old Contact-Info Start/Restart control is gone.
  assert.doesNotMatch(panel, /\? 'Restart' : 'Start'/);
});
