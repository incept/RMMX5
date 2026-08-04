import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateEmailImage } from '../lib/uploads.ts';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('validateEmailImage accepts a real PNG', async () => {
  const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'a.png', {
    type: 'image/png',
  });
  assert.equal(await validateEmailImage(png), null);
});

test('validateEmailImage rejects SVG (script vector)', async () => {
  const svg = new File([Buffer.from('<svg onload="x()"></svg>')], 'a.svg', {
    type: 'image/svg+xml',
  });
  assert.match(String(await validateEmailImage(svg)), /PNG, JPEG, GIF, or WebP/);
});

test('validateEmailImage rejects bytes that do not match the declared type', async () => {
  const fake = new File([new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])], 'b.png', {
    type: 'image/png',
  });
  assert.match(String(await validateEmailImage(fake)), /do not match/);
});

test('validateEmailImage rejects oversized files', async () => {
  const big = new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', { type: 'image/png' });
  assert.match(String(await validateEmailImage(big)), /5 MB/);
});

test('upload route is admin-gated, validates, returns a public email-assets URL', async () => {
  const route = await read('../app/api/email/images/route.ts');
  assert.match(route, /requireAdmin/);
  assert.match(route, /validateEmailImage/);
  assert.match(route, /EMAIL_ASSET_BUCKET/);
  assert.match(route, /getPublicUrl/);
  assert.match(route, /unreferencedEmailAssetBytes/);
  assert.match(route, /\.from\('email_assets'\)/);
  assert.match(route, /runtime = 'nodejs'/);
});

test('migration provisions a PUBLIC email-assets bucket with image-only mime allowlist', async () => {
  const mig = await read('../supabase/migrations/0047_email_assets_bucket.sql');
  assert.match(mig, /insert into storage\.buckets/i);
  assert.match(mig, /'email-assets'/);
  assert.match(mig, /true/); // public
  assert.match(mig, /allowed_mime_types/);
  assert.match(mig, /image\/png/);
});
