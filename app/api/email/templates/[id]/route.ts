import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import { sanitizeEmailHtml } from '@/lib/html-sanitize';
import { markEmailAssetsReferenced } from '@/lib/email-assets';

type Params = { params: Promise<{ id: string }> };
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PATCH(request: Request, { params }: Params) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: 'A valid template id is required' }, { status: 400 });
  }
  try {
    const body = await readJsonBody(request, 512 * 1024);
    const name = String(body?.name ?? '').trim().slice(0, 200);
    const subject = String(body?.subject ?? '').trim().slice(0, 500);
    const html = sanitizeEmailHtml(String(body?.html ?? '').slice(0, 250_000));
    if (!name) return NextResponse.json({ error: 'Template name is required' }, { status: 400 });

    const admin = createAdminClient();
    await markEmailAssetsReferenced(admin, html);
    const { data, error } = await admin
      .from('email_templates')
      .update({ name, subject, html })
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiFailure('api:email/templates/[id]', error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: 'A valid template id is required' }, { status: 400 });
  }
  try {
    const { data, error } = await createAdminClient()
      .from('email_templates')
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiFailure('api:email/templates/[id]', error);
  }
}
