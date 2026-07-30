import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { validIdempotencyKey } from '@/lib/bulk-delivery';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import { logDebug } from '@/lib/debug-log';
import { isValidISODate } from '@/lib/valid-date';

const MAX_CLIENTS = 1000;
const IMPORT_BODY_BYTES = 8 * 1024 * 1024;
const CHUNK = 100;
const LINK_CAP = 14;
const LINK_STATUSES = new Set(['live', 'requested', 'removed']);
const text = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max);

/**
 * Imports a grouped client roster (parsed client-side by lib/client-import.ts)
 * as clients: each row is stamped with the configured client status so it lands
 * in the Clients tab, and its removal URLs become numbered Link Data. Admin-only
 * and idempotent per Idempotency-Key, mirroring /api/import for contacts.
 */
export async function POST(request: Request) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;

  let body: any;
  try {
    body = await readJsonBody(request, IMPORT_BODY_BYTES);
  } catch (error) {
    return apiFailure('api:import/clients', error);
  }

  const requestKey = request.headers.get('idempotency-key');
  if (!validIdempotencyKey(requestKey)) {
    return NextResponse.json({ error: 'A valid Idempotency-Key header is required' }, { status: 400 });
  }

  const clients: any[] = body.clients ?? [];
  if (!Array.isArray(clients) || !clients.length) {
    return NextResponse.json({ error: 'No clients to import' }, { status: 400 });
  }
  if (clients.length > MAX_CLIENTS) {
    return NextResponse.json(
      { error: `Imports are limited to ${MAX_CLIENTS} clients per request` },
      { status: 413 }
    );
  }

  const admin = createAdminClient();

  // Resolve the client status so imported rows land in the Clients tab. Prefer a
  // status literally named "Client"; otherwise the first status flagged client.
  const { data: clientStatuses, error: statusError } = await admin
    .from('statuses')
    .select('id, name')
    .eq('is_client_status', true);
  if (statusError) return apiFailure('api:import/clients', statusError);
  if (!clientStatuses?.length) {
    return NextResponse.json(
      {
        error:
          'No client status is configured. In Statuses & Stages, tick the "client" box on your Client status first.',
      },
      { status: 400 }
    );
  }
  // An explicit choice from the wizard wins (validated against the client-status
  // set). Otherwise: a status literally named "Client", else the sole client
  // status. Refuse to guess among several — picking the wrong lifecycle status
  // (Former, Cancelled…) would misfile hundreds of records.
  const requestedStatusId = typeof body.statusId === 'string' ? body.statusId : null;
  let clientStatusId: string;
  if (requestedStatusId) {
    if (!clientStatuses.some((s) => s.id === requestedStatusId)) {
      return NextResponse.json(
        { error: 'The chosen import status is not a client status.' },
        { status: 400 }
      );
    }
    clientStatusId = requestedStatusId;
  } else {
    const named = clientStatuses.find((s) => s.name.trim().toLowerCase() === 'client');
    if (named) {
      clientStatusId = named.id;
    } else if (clientStatuses.length === 1) {
      clientStatusId = clientStatuses[0].id;
    } else {
      return NextResponse.json(
        {
          error:
            'Several client statuses exist — choose which one to import into, or name your primary one "Client".',
        },
        { status: 400 }
      );
    }
  }

  // Validate + normalise the whole request before the first write.
  const prepared: Record<string, any>[] = [];
  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    const name = text(c?.name, 300);
    if (!name) continue; // a nameless group is noise
    const links: { position: number; url: string; status: string }[] = [];
    const rawLinks = Array.isArray(c.links) ? c.links.slice(0, LINK_CAP) : [];
    for (let p = 0; p < rawLinks.length; p++) {
      const url = text(rawLinks[p]?.url, 2048);
      if (!url) continue;
      if (!/^https?:\/\//i.test(url)) {
        return NextResponse.json(
          { error: `Client ${i + 1} (${name}), link ${p + 1}: only HTTP(S) URLs are allowed` },
          { status: 400 }
        );
      }
      const status = text(rawLinks[p]?.status, 20).toLowerCase();
      links.push({
        position: links.length + 1,
        url,
        status: LINK_STATUSES.has(status) ? status : 'live',
      });
    }
    const gross = c.grossRevenue;
    const grossValid =
      typeof gross === 'number' && Number.isFinite(gross) && gross >= 0 && gross <= 99_999_999;
    const signed = text(c.signedDate, 10);
    prepared.push({
      name,
      phone: text(c.phone, 40) || null,
      email: text(c.email, 320) || null,
      state: text(c.state, 80) || null,
      source: text(c.source, 200) || 'client import',
      status_id: clientStatusId,
      gross_revenue: grossValid ? gross : null,
      signed_date: isValidISODate(signed) ? signed : null,
      links,
    });
  }

  if (!prepared.length) {
    return NextResponse.json(
      { error: 'No importable clients (every row was missing a name)' },
      { status: 400 }
    );
  }

  const contactIds: string[] = [];
  try {
    for (let offset = 0; offset < prepared.length; offset += CHUNK) {
      const { data, error } = await admin.rpc('import_client_chunk', {
        p_request_key: `${requestKey}:${offset / CHUNK}`,
        p_rows: prepared.slice(offset, offset + CHUNK),
        p_created_by: auth.profile.id,
      });
      if (error) throw error;
      contactIds.push(...((data ?? []) as string[]));
    }

    const totalLinks = prepared.reduce((sum, row) => sum + row.links.length, 0);
    const { error: logError } = await admin.from('imports').upsert(
      {
        request_key: requestKey,
        filename: text(body.filename ?? 'client import', 255),
        source: 'csv',
        mapping: { kind: 'client-roster' },
        total_rows: clients.length,
        imported_rows: contactIds.length,
        status: 'done',
        error: null,
        created_by: auth.profile.id,
      },
      { onConflict: 'request_key' }
    );
    // The audit row is bookkeeping; a failure here must not lose a done import.
    if (logError) {
      await logDebug({
        source: 'api:import/clients',
        message: `client import audit log failed: ${logError.message}`,
        context: { request_key: requestKey },
      });
    }

    return NextResponse.json({
      imported: contactIds.length,
      totalClients: clients.length,
      totalLinks,
    });
  } catch (error) {
    await logDebug({
      source: 'api:import/clients',
      message: error instanceof Error ? error.message : String(error),
      context: { request_key: requestKey, committed: contactIds.length },
    });
    return apiFailure('api:import/clients', error, {
      context: { request_key: requestKey, committed: contactIds.length },
    });
  }
}
