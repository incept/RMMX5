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
    if (!['national', 'state', 'county'].includes(body.scope)) {
      return NextResponse.json({ error: 'Invalid coverage scope' }, { status: 400 });
    }
    const state = body.scope === 'national' ? null : String(body.scope_state ?? '').toUpperCase();
    const county =
      body.scope === 'county' ? String(body.scope_county ?? '').trim().slice(0, 120) : null;
    if (body.scope !== 'national' && (!state || !STATE_CODES.has(state))) {
      return NextResponse.json({ error: 'A valid state is required' }, { status: 400 });
    }
    if (body.scope === 'county' && !county) {
      return NextResponse.json({ error: 'A county is required for county scope' }, { status: 400 });
    }
    const priority = Number(body.priority);
    if (!Number.isInteger(priority) || priority < 1 || priority > 1000) {
      return NextResponse.json({ error: 'Priority must be from 1 to 1000' }, { status: 400 });
    }
    const { data, error } = await createAdminClient()
      .from('probe_sites')
      .update({
        active: body.active === true,
        serp_fallback: body.serp_fallback === true,
        priority,
        scope: body.scope,
        scope_state: state,
        scope_county: county,
      })
      .eq('id', body.id)
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
      context: { site_id: typeof body?.id === 'string' ? body.id : null },
    }).catch(() => {});
    return apiFailure('api:admin/probe-sites', error);
  }
}
