import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { readJsonBody } from '@/lib/request-limits';
import { logDebug, errorMessage } from '@/lib/debug-log';

type Params = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Merge another contact INTO this one. The whole merge — blank-filling fields,
 * moving calls/emails/activity/links/candidates, deleting the duplicate — is a
 * single database transaction (merge_contacts, migration 0026), because a
 * half-merged pair is worse than no merge at all.
 *
 * Admin-only: this deletes a contact, and deletion is already admin-gated.
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const { id } = await params;

  let body: any;
  try {
    body = await readJsonBody(request, 4 * 1024);
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
  const mergeId = typeof body?.mergeId === 'string' ? body.mergeId : '';
  if (!UUID.test(mergeId)) {
    return NextResponse.json({ error: 'mergeId must be a contact id' }, { status: 400 });
  }
  if (mergeId === id) {
    return NextResponse.json({ error: 'Cannot merge a contact into itself' }, { status: 400 });
  }

  try {
    const { data, error } = await createAdminClient().rpc('merge_contacts', {
      p_winner: id,
      p_loser: mergeId,
      p_actor: auth.profile.id,
    });
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, ...((data as Record<string, unknown>) ?? {}) });
  } catch (e) {
    const message = errorMessage(e);
    await logDebug({
      level: 'error',
      source: 'contacts:merge',
      message: `Merge failed: ${message}`,
      contactId: id,
      context: { merge_id: mergeId },
    }).catch(() => {});
    // "function merge_contacts does not exist" means migration 0026 has not
    // been run — say so instead of leaking a bare SQL error.
    const friendly = /merge_contacts.*does not exist/i.test(message)
      ? 'Merge is not installed yet — run migration 0026_merge_contacts.sql in Supabase first.'
      : `Merge failed: ${message}`;
    return NextResponse.json({ error: friendly }, { status: 500 });
  }
}
