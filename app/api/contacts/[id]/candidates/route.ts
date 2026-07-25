import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { applyScores } from '@/lib/scoring';
import { logActivity } from '@/lib/activity';

type Params = { params: Promise<{ id: string }> };

/** GET — this contact's search candidates, strongest corroboration first. */
export async function GET(_request: Request, { params }: Params) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const { id } = await params;

  const { data, error } = await createAdminClient()
    .from('search_candidates')
    .select('*')
    .eq('contact_id', id)
    .order('status')
    .order('confidence', { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ candidates: data ?? [] });
}

/**
 * PATCH { candidateId, action } — 'accept' promotes the candidate into the
 * first free link slot; 'reject' hides it. Accepting is the human confirmation
 * step the whole candidate model exists for, so it is what writes to
 * contact_links, never the search itself.
 */
export async function PATCH(request: Request, { params }: Params) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const { id } = await params;
  const body = await request.json();
  const action = body.action;

  if (action !== 'accept' && action !== 'reject') {
    return NextResponse.json({ error: 'action must be accept or reject' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: candidate } = await admin
    .from('search_candidates')
    .select('*')
    .eq('id', body.candidateId)
    .eq('contact_id', id)
    .maybeSingle();
  if (!candidate) return NextResponse.json({ error: 'Candidate not found' }, { status: 404 });

  const stamp = {
    status: action === 'accept' ? 'accepted' : 'rejected',
    reviewed_by: auth.profile.id,
    reviewed_at: new Date().toISOString(),
  };

  if (action === 'reject') {
    await admin.from('search_candidates').update(stamp).eq('id', candidate.id);
    return NextResponse.json({ ok: true, status: 'rejected' });
  }

  // Find the first empty slot; the 14 slots are a hard product limit, so a full
  // set is a real answer rather than an error to swallow.
  const { data: links } = await admin
    .from('contact_links')
    .select('position, url')
    .eq('contact_id', id);
  const taken = new Set((links ?? []).filter((l) => l.url).map((l) => l.position));
  let position = 0;
  for (let p = 1; p <= 14; p++) {
    if (!taken.has(p)) {
      position = p;
      break;
    }
  }
  if (!position) {
    return NextResponse.json(
      { error: 'All 14 link slots are filled — free one before accepting more.' },
      { status: 409 }
    );
  }

  const { error: linkError } = await admin.from('contact_links').upsert(
    { contact_id: id, position, url: candidate.url, status: 'live' },
    { onConflict: 'contact_id,position' }
  );
  if (linkError) return NextResponse.json({ error: linkError.message }, { status: 400 });

  await admin.from('search_candidates').update(stamp).eq('id', candidate.id);
  const scores = await applyScores(id);

  await logActivity({
    contactId: id,
    actorId: auth.profile.id,
    type: 'updated',
    description: `Accepted candidate from ${candidate.source_detail ?? candidate.source} into link slot ${position}`,
    meta: { url: candidate.url, confidence: candidate.confidence },
  });

  return NextResponse.json({ ok: true, status: 'accepted', position, ...scores });
}
