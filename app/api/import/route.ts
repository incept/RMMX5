import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { validIdempotencyKey } from '@/lib/bulk-delivery';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import { logDebug } from '@/lib/debug-log';

const MAX_IMPORT_ROWS = 1000;
const IMPORT_BODY_BYTES = 5 * 1024 * 1024;
const CHUNK = 100;
const text = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max);

export async function POST(request: Request) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;

  let body: any;
  try {
    body = await readJsonBody(request, IMPORT_BODY_BYTES);
  } catch (error) {
    return apiFailure('api:import', error);
  }

  const requestKey = request.headers.get('idempotency-key');
  if (!validIdempotencyKey(requestKey)) {
    return NextResponse.json(
      { error: 'A valid Idempotency-Key header is required' },
      { status: 400 }
    );
  }

  const rows: Record<string, string>[] = body.rows ?? [];
  if (!Array.isArray(rows) || !rows.length) {
    return NextResponse.json({ error: 'No rows to import' }, { status: 400 });
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    return NextResponse.json(
      { error: `Imports are limited to ${MAX_IMPORT_ROWS} rows per request` },
      { status: 413 }
    );
  }

  const admin = createAdminClient();
  const { data: statuses, error: statusesError } = await admin.from('statuses').select('id, name');
  if (statusesError) return apiFailure('api:import', statusesError);
  const statusByName = new Map((statuses ?? []).map((s) => [s.name.toLowerCase(), s.id]));
  const defaultStatus = statusByName.get('new') ?? null;
  const usable = rows.filter((row) => row.name || row.email);

  // Validate and normalise the entire request before the first transaction.
  // A malformed URL can no longer leave earlier contacts partially inserted.
  const prepared: Record<string, any>[] = [];
  for (let rowIndex = 0; rowIndex < usable.length; rowIndex++) {
    const row = usable[rowIndex];
    const links: { position: number; url: string; status: string }[] = [];
    const linkStatus = ['live', 'requested', 'removed'].includes(
      text(row.link_status, 20).toLowerCase()
    )
      ? text(row.link_status, 20).toLowerCase()
      : 'live';
    for (let position = 1; position <= 14; position++) {
      const url = text(row[`link${position}`], 2048);
      if (!url) continue;
      if (!/^https?:\/\//i.test(url)) {
        return NextResponse.json(
          { error: `Row ${rowIndex + 1}, link ${position}: only HTTP(S) URLs are allowed` },
          { status: 400 }
        );
      }
      links.push({ position, url, status: linkStatus });
    }
    prepared.push({
      name: text(row.name || row.email || '(no name)', 300),
      email: text(row.email, 320) || null,
      phone: text(row.phone, 40) || null,
      city: text(row.city, 120) || null,
      state: text(row.state, 80) || null,
      status_id:
        (row.status ? statusByName.get(text(row.status, 200).toLowerCase()) : defaultStatus) ??
        defaultStatus,
      browser: text(row.browser, 500) || null,
      ppc_kw: text(row.ppc_kw, 500) || null,
      source: text(row.source || 'import', 120),
      ip: text(row.ip, 64) || null,
      utm: text(row.utm, 1000) || null,
      links,
    });
  }

  const contactIds: string[] = [];
  try {
    for (let offset = 0; offset < prepared.length; offset += CHUNK) {
      const { data, error } = await admin.rpc('import_contact_chunk', {
        p_request_key: `${requestKey}:${offset / CHUNK}`,
        p_rows: prepared.slice(offset, offset + CHUNK),
        p_created_by: auth.profile.id,
      });
      if (error) throw error;
      contactIds.push(...((data ?? []) as string[]));
    }

    const { error: logError } = await admin.from('imports').upsert(
      {
        request_key: requestKey,
        filename: text(body.filename ?? 'import', 255),
        source: body.source === 'csv' ? 'csv' : 'monday',
        mapping: body.mapping ?? {},
        total_rows: rows.length,
        imported_rows: contactIds.length,
        status: 'done',
        error: null,
        created_by: auth.profile.id,
      },
      { onConflict: 'request_key' }
    );
    if (logError) throw logError;

    return NextResponse.json({
      imported: contactIds.length,
      total: rows.length,
      skipped: rows.length - usable.length,
      errors: [],
    });
  } catch (error) {
    await logDebug({
      source: 'api:import',
      message: error instanceof Error ? error.message : String(error),
      context: { request_key: requestKey, committed_rows: contactIds.length },
    });
    return apiFailure('api:import', error, {
      context: { request_key: requestKey, committed_rows: contactIds.length },
    });
  }
}
