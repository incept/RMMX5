import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { applyScores } from '@/lib/scoring';
import { logActivity } from '@/lib/activity';
import { fireNotification } from '@/lib/notifications';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';

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
  let body: any;
  try {
    body = await readJsonBody(request, 128 * 1024);
  } catch (error) {
    return apiFailure('api:contacts/[id]/links', error);
  }
  const { links } = body;
  if (!Array.isArray(links)) {
    return NextResponse.json({ error: 'links array required' }, { status: 400 });
  }
  if (links.length > 14) {
    return NextResponse.json({ error: 'A contact can have at most 14 links' }, { status: 400 });
  }
  const normalized: { position: number; url: string; status: string }[] = [];
  const positions = new Set<number>();
  for (const link of links) {
    const position = Number(link?.position);
    if (!Number.isInteger(position) || position < 1 || position > 14 || positions.has(position)) {
      return NextResponse.json({ error: 'Link positions must be unique integers from 1 to 14' }, { status: 400 });
    }
    positions.add(position);
    const url = String(link?.url ?? '').trim();
    if (url.length > 2048) {
      return NextResponse.json({ error: `Link ${position} is too long` }, { status: 400 });
    }
    if (url) {
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
      } catch {
        return NextResponse.json({ error: `Link ${position} must be an HTTP(S) URL` }, { status: 400 });
      }
    }
    normalized.push({
      position,
      url,
      status: ['live', 'requested', 'removed'].includes(link?.status) ? link.status : 'live',
    });
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
  for (const link of normalized) {
    const { position, url, status } = link;
    const prev = byPosition.get(position);

    if (!url) {
      if (prev) {
        const { error } = await admin
          .from('contact_links')
          .delete()
          .eq('contact_id', id)
          .eq('position', position);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        changes.push(`Link ${position} cleared`);
      }
      continue;
    }

    if (!prev || prev.url !== url || prev.status !== status) {
      const { error } = await admin.from('contact_links').upsert(
        { contact_id: id, position, url, status, updated_at: new Date().toISOString() },
        { onConflict: 'contact_id,position' }
      );
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
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

  const { data: updated, error: readError } = await admin
    .from('contact_links')
    .select('*')
    .eq('contact_id', id)
    .order('position');
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });

  return NextResponse.json({ links: updated, scores });
}
