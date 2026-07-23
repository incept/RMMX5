import { NextResponse } from 'next/server';
import { requireUser, requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { logActivity } from '@/lib/activity';
import { fireNotification } from '@/lib/notifications';
import { startSequencesForStatus, stopEnrollmentsFor } from '@/lib/sequence-runner';

type Params = { params: Promise<{ id: string }> };

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
  const patch = await request.json();

  const admin = createAdminClient();
  const { data: before } = await admin.from('contacts').select('*').eq('id', id).single();
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const allowed = [
    'name', 'city', 'state', 'email', 'phone', 'status_id', 'browser', 'ppc_kw',
    'source', 'ip', 'utm', 'stage_id', 'client_since', 'service_days', 'custom', 'owner_id',
  ];
  const updates: Record<string, any> = {};
  for (const key of allowed) if (key in patch) updates[key] = patch[key];
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

  const { data: after, error } = await admin
    .from('contacts')
    .update(updates)
    .eq('id', id)
    .select('*, statuses ( name, color, is_client_status )')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  if (statusChanged) {
    const statusName = (after as any).statuses?.name ?? 'none';
    await logActivity({
      contactId: id,
      actorId: auth.profile.id,
      type: 'status_change',
      description: `Status changed to "${statusName}"`,
      meta: { from: before.status_id, to: updates.status_id },
    });
    await stopEnrollmentsFor(id, 'status_change', updates.status_id ?? undefined);
    if (updates.status_id) await startSequencesForStatus(id, updates.status_id);
    await fireNotification('status_change', after, { status: statusName });
  } else {
    await logActivity({
      contactId: id,
      actorId: auth.profile.id,
      type: 'updated',
      description: `Contact updated (${Object.keys(updates).join(', ')})`,
    });
  }

  return NextResponse.json({ contact: after });
}

export async function DELETE(_request: Request, { params }: Params) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const { id } = await params;

  const { error } = await createAdminClient().from('contacts').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
