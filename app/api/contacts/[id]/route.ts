import { NextResponse } from 'next/server';
import { requireUser, requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { logActivity } from '@/lib/activity';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import { logDebug } from '@/lib/debug-log';

type Params = { params: Promise<{ id: string }> };

/** Server-filtered contact detail. Revenue never crosses the worker boundary. */
export async function GET(_request: Request, { params }: Params) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const { id } = await params;
  const { data, error } = await createAdminClient()
    .from('contacts')
    .select('*, statuses ( id, name, color, is_client_status ), stages ( id, name, color )')
    .eq('id', id)
    .maybeSingle();
  if (error) return apiFailure('api:contacts/[id]', error, { contactId: id });
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!['admin', 'super_admin'].includes(auth.profile.role)) {
    delete (data as Record<string, any>).revenue_projection;
  }
  return NextResponse.json({ contact: data });
}

/**
 * PATCH updates a contact. Status changes carry side effects:
 *   * moving into a client status stamps client_since (starts the countdown)
 *   * status_change sequence triggers start/stop
 *   * the status_change notification rule fires
 *   * everything lands in the activity log
 */
export async function PATCH(request: Request, { params }: Params) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const { id } = await params;
  let patch: Record<string, any>;
  try {
    patch = await readJsonBody(request, 256 * 1024);
  } catch (error) {
    return apiFailure('api:contacts/[id]', error);
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return NextResponse.json({ error: 'A contact patch object is required' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: before } = await admin.from('contacts').select('*').eq('id', id).single();
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const allowed = [
    'name', 'city', 'state', 'email', 'phone', 'status_id', 'browser', 'ppc_kw',
    'source', 'ip', 'utm', 'stage_id', 'client_since', 'service_days', 'custom', 'owner_id',
    'device', 'source_url', 'wp_user', 'gclid',
  ];
  const updates: Record<string, any> = {};
  for (const key of allowed) if (key in patch) updates[key] = patch[key];
  const stringLimits: Record<string, number> = {
    name: 200,
    city: 120,
    state: 100,
    email: 320,
    phone: 50,
    browser: 200,
    ppc_kw: 500,
    source: 200,
    ip: 64,
    utm: 2000,
    device: 200,
    source_url: 2048,
    wp_user: 200,
    gclid: 500,
  };
  for (const [key, max] of Object.entries(stringLimits)) {
    if (key in updates && updates[key] != null) {
      updates[key] = String(updates[key]).trim().slice(0, max);
    }
  }
  if ('service_days' in updates) {
    const value = Number(updates.service_days);
    if (!Number.isInteger(value) || value < 0 || value > 3650) {
      return NextResponse.json({ error: 'service_days must be an integer from 0 to 3650' }, { status: 400 });
    }
    updates.service_days = value;
  }
  if ('custom' in updates && (updates.custom == null || typeof updates.custom !== 'object' || Array.isArray(updates.custom))) {
    return NextResponse.json({ error: 'custom must be an object' }, { status: 400 });
  }
  if (updates.source_url) {
    try {
      const sourceUrl = new URL(updates.source_url);
      if (!['http:', 'https:'].includes(sourceUrl.protocol)) throw new Error();
    } catch {
      return NextResponse.json({ error: 'source_url must be an HTTP(S) URL' }, { status: 400 });
    }
  }
  if (!Object.keys(updates).length) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  const statusChanged = 'status_id' in updates && updates.status_id !== before.status_id;

  if (statusChanged && updates.status_id) {
    const { data: newStatus } = await admin
      .from('statuses')
      .select('name, is_client_status')
      .eq('id', updates.status_id)
      .single();
    // Becoming a client starts the service countdown (if not already running).
    if (newStatus?.is_client_status && !before.client_since) {
      updates.client_since = new Date().toISOString();
    }
  }

  if (statusChanged) {
    const result = await admin.rpc('update_contact_status_atomic', {
      p_contact_id: id,
      p_expected_updated_at: before.updated_at,
      p_updates: updates,
      p_actor_id: auth.profile.id,
    });
    if (result.error) {
      const conflict = result.error.code === '40001';
      return NextResponse.json(
        { error: conflict ? 'This contact changed in another session. Reload and try again.' : result.error.message },
        { status: conflict ? 409 : 400 }
      );
    }
  } else {
    const { data: updated, error } = await admin
      .from('contacts')
      .update(updates)
      .eq('id', id)
      .eq('updated_at', before.updated_at)
      .select('id')
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    if (!updated) {
      return NextResponse.json(
        { error: 'This contact changed in another session. Reload and try again.' },
        { status: 409 }
      );
    }
    await logActivity({
      contactId: id,
      actorId: auth.profile.id,
      type: 'updated',
      description: `Contact updated (${Object.keys(updates).join(', ')})`,
    });
  }

  const { data: after, error: readError } = await admin
    .from('contacts')
    .select('*, statuses ( name, color, is_client_status )')
    .eq('id', id)
    .single();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 400 });
  return NextResponse.json({ contact: after });
}

export async function DELETE(_request: Request, { params }: Params) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const { id } = await params;
  const admin = createAdminClient();

  // Delete the database row first so all relational state disappears
  // transactionally. Storage is external to Postgres; best-effort cleanup after
  // commit prevents normal contact deletion from being held hostage by storage.
  const { data: files, error: fileError } = await admin
    .from('contact_files')
    .select('storage_path')
    .eq('contact_id', id);
  if (fileError) return apiFailure('api:contacts/[id]', fileError, { contactId: id });

  const { data: deleted, error } = await admin
    .from('contacts')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (error) return apiFailure('api:contacts/[id]', error, { contactId: id });
  if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const paths = (files ?? []).map((file) => file.storage_path).filter(Boolean);
  let storageObjectsRemoved = 0;
  if (paths.length) {
    const { error: storageError } = await admin.storage.from('contact-files').remove(paths);
    if (storageError) {
      await logDebug({
        level: 'error',
        source: 'files:orphan-contact-delete',
        message: `Contact was deleted but ${paths.length} storage object(s) could not be removed: ${storageError.message}`,
        context: { contact_id: id, paths },
      }).catch(() => {});
    } else {
      storageObjectsRemoved = paths.length;
    }
  }
  return NextResponse.json({ ok: true, storageObjectsRemoved });
}
