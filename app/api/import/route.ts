import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { applyScores } from '@/lib/scoring';
import { logActivity } from '@/lib/activity';

/**
 * POST { filename, source, mapping, rows } — rows already parsed client-side
 * (lib/monday-import.ts) and mapped to CRM field keys:
 *   name, email, phone, city, state, status (by name), browser, ppc_kw,
 *   source, ip, utm, link1..link14, link_status
 */
export async function POST(request: Request) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;

  const body = await request.json();
  const rows: Record<string, string>[] = body.rows ?? [];
  if (!rows.length) return NextResponse.json({ error: 'No rows to import' }, { status: 400 });

  const admin = createAdminClient();
  const { data: statuses } = await admin.from('statuses').select('id, name');
  const statusByName = new Map((statuses ?? []).map((s) => [s.name.toLowerCase(), s.id]));
  const { data: defaultStatus } = await admin
    .from('statuses')
    .select('id')
    .eq('name', 'New')
    .maybeSingle();

  let imported = 0;
  const errors: string[] = [];

  for (const row of rows) {
    try {
      if (!row.name && !row.email) continue; // nothing identifiable

      const statusId = row.status
        ? (statusByName.get(row.status.toLowerCase().trim()) ?? defaultStatus?.id)
        : defaultStatus?.id;

      const { data: contact, error } = await admin
        .from('contacts')
        .insert({
          name: row.name || row.email || '(no name)',
          email: row.email || null,
          phone: row.phone || null,
          city: row.city || null,
          state: row.state || null,
          status_id: statusId ?? null,
          browser: row.browser || null,
          ppc_kw: row.ppc_kw || null,
          source: row.source || 'import',
          ip: row.ip || null,
          utm: row.utm || null,
        })
        .select('id')
        .single();
      if (error || !contact) throw new Error(error?.message ?? 'insert failed');

      const linkStatus = ['live', 'requested', 'removed'].includes(
        (row.link_status ?? '').toLowerCase().trim()
      )
        ? (row.link_status.toLowerCase().trim() as string)
        : 'live';

      let hasLinks = false;
      for (let i = 1; i <= 14; i++) {
        const url = (row[`link${i}`] ?? '').trim();
        if (!url) continue;
        hasLinks = true;
        await admin.from('contact_links').insert({
          contact_id: contact.id,
          position: i,
          url,
          status: linkStatus,
        });
      }
      if (hasLinks) await applyScores(contact.id);

      imported += 1;
    } catch (e: any) {
      errors.push(e.message);
    }
  }

  const { data: importRow } = await admin
    .from('imports')
    .insert({
      filename: body.filename ?? 'import',
      source: body.source === 'csv' ? 'csv' : 'monday',
      mapping: body.mapping ?? {},
      total_rows: rows.length,
      imported_rows: imported,
      status: errors.length === rows.length ? 'failed' : 'done',
      error: errors.length ? errors.slice(0, 5).join(' | ') : null,
      created_by: auth.profile.id,
    })
    .select('id')
    .single();

  await logActivity({
    actorId: auth.profile.id,
    type: 'import',
    description: `Imported ${imported}/${rows.length} contacts from ${body.filename ?? 'file'}`,
    meta: { import_id: importRow?.id },
  });

  return NextResponse.json({ imported, total: rows.length, errors: errors.slice(0, 10) });
}
