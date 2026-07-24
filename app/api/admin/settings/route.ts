import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { getSetting, setSetting } from '@/lib/settings';

const KNOWN_KEYS = [
  'brightdata',
  'emailit',
  'textlink',
  'stripe',
  'fluent_forms',
  'inbound_email',
  'ipapi',
  'voicemail',
  'search',
  'defaults',
] as const;

/** GET — all integration/config settings (admin only; served server-side only). */
export async function GET() {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;

  const entries = await Promise.all(
    KNOWN_KEYS.map(async (key) => [key, await getSetting(key)] as const)
  );
  return NextResponse.json({ settings: Object.fromEntries(entries) });
}

/** PUT { key, value } — upsert one settings blob. */
export async function PUT(request: Request) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const body = await request.json();

  if (!KNOWN_KEYS.includes(body.key)) {
    return NextResponse.json({ error: `Unknown settings key: ${body.key}` }, { status: 400 });
  }
  if (typeof body.value !== 'object' || body.value === null) {
    return NextResponse.json({ error: 'value must be an object' }, { status: 400 });
  }

  await setSetting(body.key, body.value, auth.profile.id);
  return NextResponse.json({ ok: true });
}
