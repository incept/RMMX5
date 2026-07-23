import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { applyScores } from '@/lib/scoring';
import { logActivity } from '@/lib/activity';
import { fireNotification } from '@/lib/notifications';

type Params = { params: Promise<{ id: string }> };

/**
 * PUT replaces the contact's link slots. Body: { links: [{ position, url, status }] }
 * Link-status changes fire the link_status_change notification rule (the
 * "your link was removed" client alert), then scores are recomputed.
 */
export async function PUT(request: Request, { params }: Params) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const { id } = await params;
  const { links } = await request.json();
  if (!Array.isArray(links)) {
    return NextResponse.json({ error: 'links array required' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: contact } = await admin.from('contacts').select('*').eq('id', id).single();
  if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data: existing } = await admin
    .from('contact_links')
    .select('position, url, status')
    .eq('contact_id', id);
  const byPosition = new Map((existing ?? []).map((l) => [l.position, l]));

  const changes: string[] = [];
  for (const link of links) {
    const position = Number(link.position);
    if (!(position >= 1 && position <= 14)) continue;
    const url = String(link.url ?? '').trim();
    const status = ['live', 'requested', 'removed'].includes(link.status) ? link.status : 'live';
    const prev = byPosition.get(position);

    if (!url) {
      if (prev) {
        await admin.from('contact_links').delete().eq('contact_id', id).eq('position', position);
        changes.push(`Link ${position} cleared`);
      }
      continue;
    }

    if (!prev || prev.url !== url || prev.status !== status) {
      await admin.from('contact_links').upsert(
        { contact_id: id, position, url, status, updated_at: new Date().toISOString() },
        { onConflict: 'contact_id,position' }
      );
      if (prev && prev.url === url && prev.status !== status) {
        changes.push(`Link ${position} → ${status}`);
        await fireNotification('link_status_change', contact, {
          link: url,
          link_status: status,
        });
      } else {
        changes.push(prev ? `Link ${position} URL updated` : `Link ${position} added`);
      }
    }
  }

  const scores = await applyScores(id);

  if (changes.length) {
    await logActivity({
      contactId: id,
      actorId: auth.profile.id,
      type: 'link_change',
      description: changes.join('; '),
      meta: { scores },
    });
  }

  const { data: updated } = await admin
    .from('contact_links')
    .select('*')
    .eq('contact_id', id)
    .order('position');

  return NextResponse.json({ links: updated, scores });
}
