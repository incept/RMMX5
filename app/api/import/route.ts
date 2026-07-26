import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { applyScores } from '@/lib/scoring';
import { logActivity } from '@/lib/activity';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';

const MAX_IMPORT_ROWS = 1000;
const IMPORT_BODY_BYTES = 5 * 1024 * 1024;
const text = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max);

/**
 * POST { filename, source, mapping, rows } — rows already parsed client-side
 * (lib/monday-import.ts) and mapped to CRM field keys:
 *   name, email, phone, city, state, status (by name), browser, ppc_kw,
 *   source, ip, utm, link1..link14, link_status
 */
export async function POST(request: Request) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;

  let body: any;
  try {
    body = await readJsonBody(request, IMPORT_BODY_BYTES);
  } catch (error) {
    return apiFailure('api:import', error);
  }
  const rows: Record<string, string>[] = body.rows ?? [];
  if (!rows.length) return NextResponse.json({ error: 'No rows to import' }, { status: 400 });
  if (!Array.isArray(rows) || rows.length > MAX_IMPORT_ROWS) {
    return NextResponse.json(
      { error: `Imports are limited to ${MAX_IMPORT_ROWS} rows per request` },
      { status: 413 }
    );
  }

  const admin = createAdminClient();
  const { data: statuses, error: statusesError } = await admin.from('statuses').select('id, name');
  if (statusesError) {
    return NextResponse.json({ error: statusesError.message }, { status: 500 });
  }
  const statusByName = new Map((statuses ?? []).map((s) => [s.name.toLowerCase(), s.id]));
  const { data: defaultStatus, error: defaultStatusError } = await admin
    .from('statuses')
    .select('id')
    .eq('name', 'New')
    .maybeSingle();
  if (defaultStatusError) {
    return NextResponse.json({ error: defaultStatusError.message }, { status: 500 });
  }

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
        name: text(row.name || row.email || '(no name)', 300),
        email: text(row.email, 320) || null,
        phone: text(row.phone, 40) || null,
        city: text(row.city, 120) || null,
        state: text(row.state, 80) || null,
        status_id:
          (row.status
            ? (statusByName.get(row.status.toLowerCase().trim()) ?? defaultStatus?.id)
            : defaultStatus?.id) ?? null,
        browser: text(row.browser, 500) || null,
        ppc_kw: text(row.ppc_kw, 500) || null,
        source: text(row.source || 'import', 120),
        ip: text(row.ip, 64) || null,
        utm: text(row.utm, 1000) || null,
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
          const url = text(row[`link${n}`], 2048);
          if (!url) continue;
          if (!/^https?:\/\//i.test(url)) {
            errors.push(`row ${offset + i + 1}, link ${n}: only http(s) URLs are allowed`);
            continue;
          }
          hasLinks = true;
          linkRows.push({ contact_id: contacts[i].id, position: n, url, status: linkStatus });
        }
        if (hasLinks) scoreIds.push(contacts[i].id);
      });

      if (linkRows.length) {
        const { error: linkError } = await admin.from('contact_links').insert(linkRows);
        if (linkError) errors.push(`links (rows ${offset + 1}–${offset + chunk.length}): ${linkError.message}`);
      }
      // Small parallel batches avoid one scoring round-trip chain per row while
      // keeping database pressure bounded on shared hosting.
      for (let scoreOffset = 0; scoreOffset < scoreIds.length; scoreOffset += 5) {
        await Promise.all(scoreIds.slice(scoreOffset, scoreOffset + 5).map((id) => applyScores(id)));
      }

      imported += chunk.length;
    } catch (e: any) {
      errors.push(`rows ${offset + 1}–${offset + chunk.length}: ${e.message}`);
    }
  }

  const { data: importRow, error: importLogError } = await admin
    .from('imports')
    .insert({
      filename: text(body.filename ?? 'import', 255),
      source: body.source === 'csv' ? 'csv' : 'monday',
      mapping: body.mapping ?? {},
      total_rows: rows.length,
      imported_rows: imported,
      status: imported === 0 ? 'failed' : 'done',
      error: errors.length ? errors.slice(0, 5).join(' | ') : null,
      created_by: auth.profile.id,
    })
    .select('id')
    .single();
  if (importLogError) {
    errors.push(`import audit row: ${importLogError.message}`);
  }

  await logActivity({
    actorId: auth.profile.id,
    type: 'import',
    description: `Imported ${imported}/${rows.length} contacts from ${text(body.filename ?? 'file', 255)}`,
    meta: { import_id: importRow?.id },
  });

  return NextResponse.json({ imported, total: rows.length, errors: errors.slice(0, 10) });
}
