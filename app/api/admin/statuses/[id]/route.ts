import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';

type Params = { params: Promise<{ id: string }> };

/**
 * DELETE a status — after moving its contacts somewhere the admin chose.
 *
 * The foreign key is ON DELETE SET NULL, so a bare delete silently strips the
 * status off every contact in it and they fall out of every status filter.
 * Deleting a stage of the pipeline should ask where its people go, the same
 * way closing a mail folder asks. Body: { moveTo?: uuid } — required whenever
 * the status still has contacts.
 */
export async function DELETE(request: Request, { params }: Params) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const { id } = await params;

  try {
    const body = await readJsonBody(request, 4 * 1024).catch(() => ({}) as any);
    const moveTo = typeof body?.moveTo === 'string' && body.moveTo ? body.moveTo : null;
    const admin = createAdminClient();

    const { data: status, error: readError } = await admin
      .from('statuses')
      .select('id, name')
      .eq('id', id)
      .maybeSingle();
    if (readError) throw readError;
    if (!status) return NextResponse.json({ error: 'Status not found' }, { status: 404 });

    const { count, error: countError } = await admin
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('status_id', id);
    if (countError) throw countError;

    let moved = 0;
    if ((count ?? 0) > 0) {
      if (!moveTo || moveTo === id) {
        return NextResponse.json(
          {
            error: `${count} contact${count === 1 ? '' : 's'} use "${status.name}" — pick a status to move them to first`,
            count,
          },
          { status: 400 }
        );
      }
      const { data: target, error: targetError } = await admin
        .from('statuses')
        .select('id')
        .eq('id', moveTo)
        .maybeSingle();
      if (targetError) throw targetError;
      if (!target) {
        return NextResponse.json({ error: 'The target status no longer exists' }, { status: 400 });
      }
      const { data: movedRows, error: moveError } = await admin
        .from('contacts')
        .update({ status_id: moveTo })
        .eq('status_id', id)
        .select('id');
      if (moveError) throw moveError;
      moved = movedRows?.length ?? 0;
    }

    const { error: deleteError } = await admin.from('statuses').delete().eq('id', id);
    if (deleteError) throw deleteError;

    return NextResponse.json({ ok: true, moved });
  } catch (error) {
    return apiFailure('api:admin/statuses/[id]', error);
  }
}
