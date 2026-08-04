import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import { logDebug } from '@/lib/debug-log';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATE_CODES = new Set(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ')
);

/** A hostname like "arrests.org" — no scheme, path, or spaces. */
function normalizeDomain(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

function optionalUrlTemplate(raw: unknown): string | null {
  const value = String(raw ?? '').trim().slice(0, 2000);
  return value || null;
}

type SiteRow = {
  domain: string;
  name: string | null;
  search_template: string;
  record_url_template: string | null;
  date_url_template: string | null;
  scope: string;
  scope_state: string | null;
  scope_county: string | null;
  family: string | null;
  active: boolean;
  serp_fallback: boolean;
  needs_render: boolean;
  needs_browser: boolean;
  priority: number;
  notes: string | null;
};

/** Validates a create/update payload into a full column set, or an error string. */
function buildSiteRow(body: any): { row: SiteRow } | { error: string } {
  const domain = normalizeDomain(body.domain);
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain)) {
    return { error: 'A valid domain is required (e.g. arrests.org)' };
  }

  const search_template = String(body.search_template ?? '').trim().slice(0, 2000);
  if (!/^https?:\/\//i.test(search_template)) {
    return { error: 'The search URL template must be a full http(s) URL' };
  }
  const record_url_template = optionalUrlTemplate(body.record_url_template);
  const date_url_template = optionalUrlTemplate(body.date_url_template);
  if (record_url_template && !/^https?:\/\//i.test(record_url_template)) {
    return { error: 'The record URL template must be a full http(s) URL' };
  }
  if (date_url_template && !/^https?:\/\//i.test(date_url_template)) {
    return { error: 'The date URL template must be a full http(s) URL' };
  }

  if (!['national', 'state', 'county'].includes(body.scope)) {
    return { error: 'Invalid coverage scope' };
  }
  const state = body.scope === 'national' ? null : String(body.scope_state ?? '').toUpperCase();
  const county =
    body.scope === 'county' ? String(body.scope_county ?? '').trim().slice(0, 120) : null;
  if (body.scope !== 'national' && (!state || !STATE_CODES.has(state))) {
    return { error: 'A valid state is required' };
  }
  if (body.scope === 'county' && !county) {
    return { error: 'A county is required for county scope' };
  }

  const priority = Number(body.priority);
  if (!Number.isInteger(priority) || priority < 1 || priority > 1000) {
    return { error: 'Priority must be a whole number from 1 to 1000' };
  }

  return {
    row: {
      domain,
      name: String(body.name ?? '').trim().slice(0, 200) || null,
      search_template,
      record_url_template,
      date_url_template,
      scope: body.scope,
      scope_state: state,
      scope_county: county,
      family: String(body.family ?? '').trim().slice(0, 120) || null,
      active: body.active === true,
      serp_fallback: body.serp_fallback === true,
      needs_render: body.needs_render === true,
      needs_browser: body.needs_browser === true,
      priority,
      notes: String(body.notes ?? '').trim().slice(0, 2000) || null,
    },
  };
}

export async function GET() {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  try {
    const { data, error } = await createAdminClient()
      .from('probe_sites')
      .select('*')
      .order('scope')
      .order('priority')
      .order('domain');
    if (error) throw error;
    return NextResponse.json({ sites: data ?? [] });
  } catch (error) {
    return apiFailure('api:admin/probe-sites', error);
  }
}

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  let body: any;
  try {
    body = await readJsonBody(request, 32 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'A probe-site object is required' }, { status: 400 });
    }
    const built = buildSiteRow(body);
    if ('error' in built) return NextResponse.json({ error: built.error }, { status: 400 });

    const { data, error } = await createAdminClient()
      .from('probe_sites')
      .insert(built.row)
      .select('id')
      .maybeSingle();
    // A duplicate domain is a user error, not a 500.
    if (error?.code === '23505') {
      return NextResponse.json(
        { error: `A site for "${built.row.domain}" already exists` },
        { status: 409 }
      );
    }
    if (error) throw error;
    return NextResponse.json({ ok: true, id: data?.id }, { status: 201 });
  } catch (error) {
    await logDebug({
      level: 'error',
      source: 'admin:probe-sites',
      message: error instanceof Error ? error.message : String(error),
      context: { op: 'create', domain: typeof body?.domain === 'string' ? body.domain : null },
    }).catch(() => {});
    return apiFailure('api:admin/probe-sites', error);
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  let body: any;
  try {
    body = await readJsonBody(request, 32 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'A probe-site object is required' }, { status: 400 });
    }
    if (typeof body.id !== 'string' || !UUID_PATTERN.test(body.id)) {
      return NextResponse.json({ error: 'A valid probe-site id is required' }, { status: 400 });
    }
    const built = buildSiteRow(body);
    if ('error' in built) return NextResponse.json({ error: built.error }, { status: 400 });

    const { data, error } = await createAdminClient()
      .from('probe_sites')
      .update(built.row)
      .eq('id', body.id)
      .select('id')
      .maybeSingle();
    if (error?.code === '23505') {
      return NextResponse.json(
        { error: `Another site already uses the domain "${built.row.domain}"` },
        { status: 409 }
      );
    }
    if (error) throw error;
    if (!data) return NextResponse.json({ error: 'Probe site not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    await logDebug({
      level: 'error',
      source: 'admin:probe-sites',
      message: error instanceof Error ? error.message : String(error),
      context: { op: 'update', site_id: typeof body?.id === 'string' ? body.id : null },
    }).catch(() => {});
    return apiFailure('api:admin/probe-sites', error);
  }
}

export async function DELETE(request: Request) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const id = new URL(request.url).searchParams.get('id');
  if (!id || !UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: 'A valid probe-site id is required' }, { status: 400 });
  }
  try {
    const { data, error } = await createAdminClient()
      .from('probe_sites')
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: 'Probe site not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    await logDebug({
      level: 'error',
      source: 'admin:probe-sites',
      message: error instanceof Error ? error.message : String(error),
      context: { op: 'delete', site_id: id },
    }).catch(() => {});
    return apiFailure('api:admin/probe-sites', error);
  }
}
