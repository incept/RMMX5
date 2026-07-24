import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { getSetting, setSetting } from '@/lib/settings';
import { maskSettingSecrets, mergeSettingSecrets } from '@/lib/settings-secrets';

const KNOWN_KEYS = [
  'brightdata',
  'emailit',
  'textlink',
  'stripe',
  'fluent_forms',
  'callscaler',
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
    KNOWN_KEYS.map(async (key) => {
      const masked = maskSettingSecrets(key, await getSetting<Record<string, any>>(key));
      return [key, masked] as const;
    })
  );
  const safe = Object.fromEntries(entries);
  return NextResponse.json({
    settings: Object.fromEntries(KNOWN_KEYS.map((key) => [key, safe[key].value])),
    configuredSecrets: Object.fromEntries(KNOWN_KEYS.map((key) => [key, safe[key].configured])),
  });
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

  const current = await getSetting<Record<string, any>>(body.key);
  const merged = mergeSettingSecrets(body.key, current, body.value);
  await setSetting(body.key, merged, auth.profile.id);
  return NextResponse.json({ ok: true });
}
