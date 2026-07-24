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

  // Batched: one contacts insert and one links insert per 100 rows, instead
  // of one round-trip per row (and per link). Large CSVs went from thousands
  // of sequential DB calls to a few dozen. Trade-off: a bad value fails its
  // whole chunk, so the error message carries the chunk range.
  const CHUNK = 100;
  const usable = rows.filter((row) => row.name || row.email);

  for (let offset = 0; offset < usable.length; offset += CHUNK) {
    const chunk = usable.slice(offset, offset + CHUNK);
    try {
      const contactRows = chunk.map((row) => ({
        name: row.name || row.email || '(no name)',
        email: row.email || null,
        phone: row.phone || null,
        city: row.city || null,
        state: row.state || null,
        status_id:
          (row.status
            ? (statusByName.get(row.status.toLowerCase().trim()) ?? defaultStatus?.id)
            : defaultStatus?.id) ?? null,
        browser: row.browser || null,
        ppc_kw: row.ppc_kw || null,
        source: row.source || 'import',
        ip: row.ip || null,
        utm: row.utm || null,
      }));

      const { data: contacts, error } = await admin
        .from('contacts')
        .insert(contactRows)
        .select('id');
      if (error || !contacts || contacts.length !== chunk.length) {
        throw new Error(error?.message ?? 'chunk insert failed');
      }

      // Returned rows are in input order, so contacts[i] belongs to chunk[i].
      const linkRows: Record<string, any>[] = [];
      const scoreIds: string[] = [];
      chunk.forEach((row, i) => {
        const linkStatus = ['live', 'requested', 'removed'].includes(
          (row.link_status ?? '').toLowerCase().trim()
        )
          ? row.link_status.toLowerCase().trim()
          : 'live';
        let hasLinks = false;
        for (let n = 1; n <= 14; n++) {
          const url = (row[`link${n}`] ?? '').trim();
          if (!url) continue;
          hasLinks = true;
          linkRows.push({ contact_id: contacts[i].id, position: n, url, status: linkStatus });
        }
        if (hasLinks) scoreIds.push(contacts[i].id);
      });

      if (linkRows.length) {
        const { error: linkError } = await admin.from('contact_links').insert(linkRows);
        if (linkError) errors.push(`links (rows ${offset + 1}–${offset + chunk.length}): ${linkError.message}`);
      }
      for (const id of scoreIds) await applyScores(id);

      imported += chunk.length;
    } catch (e: any) {
      errors.push(`rows ${offset + 1}–${offset + chunk.length}: ${e.message}`);
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
