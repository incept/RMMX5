import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import { sanitizeEmailHtml } from '@/lib/html-sanitize';
import { markEmailAssetsReferenced } from '@/lib/email-assets';

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
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
      .insert({ name, subject, html })
      .select('id')
      .single();
    if (error) throw error;
    return NextResponse.json({ id: data.id }, { status: 201 });
  } catch (error) {
    return apiFailure('api:email/templates', error);
  }
}
