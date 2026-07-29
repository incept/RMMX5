import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { applyScores } from '@/lib/scoring';
import { logActivity } from '@/lib/activity';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import { canonicalUrl } from '@/lib/integrations/brightdata';
import { logDebug, errorMessage } from '@/lib/debug-log';

type Params = { params: Promise<{ id: string }> };

/**
 * A URL a human took OUT of a slot must STAY out. The automatic search's only
 * dedupe was against URLs currently in slots, so deleting a link just made
 * room for the next run to re-place the same page — the operator deleted one
 * roster URL three times before this existed. The removal is remembered as a
 * rejected candidate: the store deep search already consults and auto search
 * now checks, and visible in the panel where it can be un-rejected if the
 * removal was a mistake. Best-effort — remembering must never block the save.
 */
async function rememberRemoval(
  admin: ReturnType<typeof createAdminClient>,
  contactId: string,
  url: string
) {
  const trimmed = String(url ?? '').trim();
  if (!trimmed) return;
  const canonical = canonicalUrl(trimmed);
  if (!canonical) return;
  try {
    const { data: existing } = await admin
      .from('search_candidates')
      .select('id, status')
      .eq('contact_id', contactId)
      .eq('canonical_url', canonical)
      .maybeSingle();
    if (existing) {
      // The human just pulled this URL out of a slot — whatever the candidate's
      // status was, their newest decision is the one that stands.
      if (existing.status !== 'rejected') {
        await admin.from('search_candidates').update({ status: 'rejected' }).eq('id', existing.id);
      }
      return;
    }
    await admin.from('search_candidates').insert({
      contact_id: contactId,
      url: trimmed,
      canonical_url: canonical,
      title: null,
      snippet: 'removed from a link slot by hand — the searches will not place it again',
      source: 'manual',
      source_detail: 'slot removal',
      round: 0,
      confidence: 0,
      matched_facts: {},
      status: 'rejected',
    });
  } catch (e) {
    await logDebug({
      level: 'warn',
      source: 'api:contacts/[id]/links',
      message: `Could not remember a removed link: ${errorMessage(e)}`,
      context: { url: trimmed },
      contactId,
    });
  }
}

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
  const removedUrls: string[] = [];
  for (const link of normalized) {
    const { position, url, status } = link;
    const prev = byPosition.get(position);

    if (!url) {
      if (prev) {
        changes.push(`Link ${position} cleared`);
        removedUrls.push(prev.url);
      }
      continue;
    }

    if (!prev || prev.url !== url || prev.status !== status) {
      // Replacing a slot's URL is also a removal of the old one.
      if (prev && prev.url && prev.url !== url) removedUrls.push(prev.url);
      if (prev && prev.url === url && prev.status !== status) {
        changes.push(`Link ${position} → ${status}`);
      } else {
        changes.push(prev ? `Link ${position} URL updated` : `Link ${position} added`);
      }
    }
  }

  const { data: updated, error: replaceError } = await admin.rpc('replace_contact_links_atomic', {
    p_contact_id: id,
    p_links: normalized,
    p_actor_id: auth.profile.id,
  });
  if (replaceError) return NextResponse.json({ error: replaceError.message }, { status: 500 });
  await Promise.all(removedUrls.map((url) => rememberRemoval(admin, id, url)));
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

  return NextResponse.json({ links: updated, scores });
}
