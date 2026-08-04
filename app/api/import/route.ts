import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { validIdempotencyKey } from '@/lib/bulk-delivery';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import { logDebug } from '@/lib/debug-log';
import { parseImportDate } from '@/lib/import-date';
import { normalizeImportUrl } from '@/lib/import-url';

const MAX_REPORTED_WARNINGS = 100;

const MAX_IMPORT_ROWS = 1000;
const IMPORT_BODY_BYTES = 5 * 1024 * 1024;
const CHUNK = 100;
const text = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max);

export async function POST(request: Request) {
  const auth = await requireAdmin();
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
  const statusIds = new Set((statuses ?? []).map((s) => s.id));
  // The wizard can choose one status for the whole batch; it becomes the fallback
  // for any row without a mapped status. An unknown/blank id falls back to "new".
  const requestedDefault =
    typeof body.defaultStatusId === 'string' && statusIds.has(body.defaultStatusId)
      ? body.defaultStatusId
      : null;
  const defaultStatus = requestedDefault ?? statusByName.get('new') ?? null;

  // Custom-field targets from the wizard arrive keyed "custom:<field_key>". Only
  // keys that still exist as custom fields are honoured, so a stale mapping (or a
  // forged key) can never write an arbitrary column into contacts.custom.
  const { data: customFieldRows, error: customFieldsError } = await admin
    .from('custom_fields')
    .select('field_key');
  if (customFieldsError) return apiFailure('api:import', customFieldsError);
  const customKeys = new Set((customFieldRows ?? []).map((f) => f.field_key as string));

  const usable = rows.filter((row) => row.name || row.email);

  // Validate and normalise the entire request before the first transaction.
  // A malformed link cell no longer sinks the whole import: it is normalised
  // when possible, skipped when not, and reported back as a warning.
  const prepared: Record<string, any>[] = [];
  const skippedLinks: string[] = [];
  for (let rowIndex = 0; rowIndex < usable.length; rowIndex++) {
    const row = usable[rowIndex];
    const links: { position: number; url: string; status: string }[] = [];
    const linkStatus = ['live', 'requested', 'removed'].includes(
      text(row.link_status, 20).toLowerCase()
    )
      ? text(row.link_status, 20).toLowerCase()
      : 'live';
    for (let position = 1; position <= 14; position++) {
      const raw = text(row[`link${position}`], 2048);
      if (!raw) continue;
      const url = normalizeImportUrl(raw);
      if (!url) {
        skippedLinks.push(
          `Row ${rowIndex + 1}, link ${position}: skipped "${raw.slice(0, 80)}" — not an HTTP/HTTPS link`
        );
        continue;
      }
      links.push({ position, url, status: linkStatus });
    }

    // Gather values mapped onto admin-defined custom fields; stored as a JSONB
    // map on contacts.custom, keyed by field_key — the same shape the contact
    // panel reads and writes.
    const custom: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!key.startsWith('custom:')) continue;
      const fieldKey = key.slice('custom:'.length);
      if (!customKeys.has(fieldKey)) continue;
      const cleaned = text(value, 2000);
      if (cleaned) custom[fieldKey] = cleaned;
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
      // Preserve the lead's original date when the sheet maps one; a blank or
      // unparseable value stays null so the DB falls back to now().
      created_at: parseImportDate(row.created_at),
      ip: text(row.ip, 64) || null,
      utm: text(row.utm, 1000) || null,
      links,
      custom,
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

    // Plain insert, not upsert: imports.request_key has a PARTIAL unique index
    // (where request_key is not null) that ON CONFLICT (request_key) cannot infer
    // — it errors "no unique or exclusion constraint matching". A duplicate key
    // is an idempotent re-run whose audit row already exists (fine to ignore);
    // any other error is real.
    const { error: logError } = await admin.from('imports').insert({
      request_key: requestKey,
      filename: text(body.filename ?? 'import', 255),
      source: body.source === 'csv' ? 'csv' : 'monday',
      mapping: body.mapping ?? {},
      total_rows: rows.length,
      imported_rows: contactIds.length,
      status: 'done',
      error: null,
      created_by: auth.profile.id,
    });
    if (logError && logError.code !== '23505') throw logError;

    return NextResponse.json({
      imported: contactIds.length,
      total: rows.length,
      skipped: rows.length - usable.length,
      errors: [],
      // Malformed link cells that were dropped so the rest could import.
      warnings: skippedLinks.slice(0, MAX_REPORTED_WARNINGS),
      skippedLinkCount: skippedLinks.length,
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
