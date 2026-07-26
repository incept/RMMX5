import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { getSetting, setSetting } from '@/lib/settings';
import { getUsageSummary } from '@/lib/usage';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';

const KNOWN_KEYS = [
  'brightdata',
  'probe_proxy',
  'probe_browser',
  'emailit',
  'textlink',
  'stripe',
  'fluent_forms',
  'callscaler',
  'inbound_email',
  'ipapi',
  'anthropic',
  'voicemail',
  'search',
  'defaults',
] as const;

// Server-written keys the UI may display but never save.
const READONLY_KEYS = ['usage'] as const;

/**
 * Which fields hold secrets, per settings blob. GET returns these MASKED
 * (last 4 characters only) so the full keys never round-trip to the admin's
 * browser — an XSS, extension, or shared screen would otherwise expose every
 * integration credential at once. PUT treats an unchanged mask as "keep the
 * stored value", so saving a section without retyping its secrets works.
 */
const SECRET_FIELDS: Record<string, string[]> = {
  brightdata: ['api_key', 'proxy_password'],
  probe_proxy: ['password'],
  emailit: ['api_key', 'webhook_signing_secret'],
  textlink: ['api_key'],
  stripe: ['secret_key'],
  fluent_forms: ['webhook_secret'],
  callscaler: ['api_key', 'webhook_secret'],
  inbound_email: ['webhook_secret'],
  ipapi: ['api_key'],
  anthropic: ['api_key'],
  voicemail: ['api_key'],
};

const MASK_PREFIX = '••••';

function maskSecret(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return value;
  return MASK_PREFIX + value.slice(-4);
}

function isMasked(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(MASK_PREFIX);
}

/** GET — all integration/config settings (admin only; secrets masked). */
export async function GET() {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;

  const keys = [...KNOWN_KEYS, ...READONLY_KEYS];
  const entries = await Promise.all(
    keys.map(async (key) => {
      const value = {
        ...(key === 'usage' ? await getUsageSummary() : await getSetting(key)),
      } as Record<string, any>;
      for (const field of SECRET_FIELDS[key] ?? []) {
        value[field] = maskSecret(value[field]);
      }
      return [key, value] as const;
    })
  );
  return NextResponse.json({ settings: Object.fromEntries(entries) });
}

/** PUT { key, value } — upsert one settings blob (masked secrets unchanged). */
export async function PUT(request: Request) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  let body: any;
  try {
    body = await readJsonBody(request, 128 * 1024);
  } catch (error) {
    return apiFailure('api:admin/settings', error);
  }

  if (!KNOWN_KEYS.includes(body.key)) {
    return NextResponse.json({ error: `Unknown settings key: ${body.key}` }, { status: 400 });
  }
  if (typeof body.value !== 'object' || body.value === null) {
    return NextResponse.json({ error: 'value must be an object' }, { status: 400 });
  }

  const value = { ...body.value } as Record<string, any>;
  if (body.key === 'brightdata') {
    // Request caps: whole numbers, enforced before each provider call.
    for (const [field, label] of [
      ['monthly_limit', 'Monthly SERP request limit'],
      ['unlocker_monthly_limit', 'Monthly unlocker request limit'],
    ] as const) {
      if (value[field] === '' || value[field] == null) continue;
      const limit = Number(value[field]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 2_147_483_647) {
        return NextResponse.json(
          { error: `${label} must be a positive whole number` },
          { status: 400 }
        );
      }
      value[field] = limit;
    }
    // Per-call prices: decimals, and validated rather than coerced, because a
    // typo that silently became 0 would report a month's spend as $0.00.
    for (const [field, label] of [
      ['serp_cost', 'Cost per SERP request'],
      ['unlocker_cost', 'Cost per unlocker request'],
    ] as const) {
      if (value[field] === '' || value[field] == null) continue;
      const cost = Number(value[field]);
      if (!Number.isFinite(cost) || cost < 0 || cost > 1000) {
        return NextResponse.json(
          { error: `${label} must be a number between 0 and 1000 (US dollars per request)` },
          { status: 400 }
        );
      }
      value[field] = cost;
    }
  }
  if (body.key === 'anthropic') {
    for (const [field, label] of [
      ['monthly_limit', 'Monthly Anthropic request limit'],
      ['input_cost_per_million', 'Input-token cost per million'],
      ['output_cost_per_million', 'Output-token cost per million'],
    ] as const) {
      if (value[field] === '' || value[field] == null) continue;
      const amount = Number(value[field]);
      const valid =
        field === 'monthly_limit'
          ? Number.isInteger(amount) && amount >= 1 && amount <= 2_147_483_647
          : Number.isFinite(amount) && amount >= 0 && amount <= 1000;
      if (!valid) {
        return NextResponse.json({ error: `${label} is invalid` }, { status: 400 });
      }
      value[field] = amount;
    }
  }
  if (body.key === 'probe_proxy') {
    if (value.host) {
      const host = typeof value.host === 'string' ? value.host.trim().toLowerCase() : '';
      if (
        !host ||
        host.length > 253 ||
        host.includes('://') ||
        host.includes(':') ||
        /[\/\\@\s]/.test(host) ||
        host === 'localhost' ||
        host === '0.0.0.0' ||
        host === '::1' ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        /^169\.254\./.test(host)
      ) {
        return NextResponse.json(
          { error: 'Proxy host must be a public hostname or IP address' },
          { status: 400 }
        );
      }
      value.host = host;
    }
    if (value.port !== '' && value.port != null) {
      const port = Number(value.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        return NextResponse.json({ error: 'Proxy port must be between 1 and 65535' }, { status: 400 });
      }
      value.port = port;
    }
  }
  if (body.key === 'probe_browser') {
    if (
      value.executable_path &&
      (typeof value.executable_path !== 'string' || value.executable_path.length > 500)
    ) {
      return NextResponse.json({ error: 'Browser executable path is invalid' }, { status: 400 });
    }
    if (value.enabled !== '' && value.enabled != null) {
      if (![true, false, 'true', 'false'].includes(value.enabled)) {
        return NextResponse.json({ error: 'Browser enabled must be true or false' }, { status: 400 });
      }
      value.enabled = value.enabled === true || value.enabled === 'true';
    }
  }
  const secretFields = SECRET_FIELDS[body.key] ?? [];
  if (secretFields.some((f) => isMasked(value[f]))) {
    const current = await getSetting<Record<string, any>>(body.key, { fresh: true });
    for (const field of secretFields) {
      if (isMasked(value[field])) value[field] = current[field] ?? '';
    }
  }

  await setSetting(body.key, value, auth.profile.id);
  return NextResponse.json({ ok: true });
}
