import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { applyScores } from '@/lib/scoring';
import { logActivity } from '@/lib/activity';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';

type Params = { params: Promise<{ id: string }> };

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

export async function PATCH(request: Request, { params }: Params) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const { id } = await params;

  let body: any;
  try {
    body = await readJsonBody(request, 32 * 1024);
  } catch (error) {
    return apiFailure('api:contacts/[id]/candidates', error);
  }
  const action = body.action;
  if (!body.candidateId || (action !== 'accept' && action !== 'reject')) {
    return NextResponse.json(
      { error: 'candidateId and action (accept or reject) are required' },
      { status: 400 }
    );
  }

  const admin = createAdminClient();
  const { data: candidate, error: candidateError } = await admin
    .from('search_candidates')
    .select('*')
    .eq('id', body.candidateId)
    .eq('contact_id', id)
    .maybeSingle();
  if (candidateError) {
    return NextResponse.json({ error: candidateError.message }, { status: 400 });
  }
  if (!candidate) return NextResponse.json({ error: 'Candidate not found' }, { status: 404 });

  if (action === 'reject') {
    const { data, error } = await admin
      .from('search_candidates')
      .update({
        status: 'rejected',
        reviewed_by: auth.profile.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', candidate.id)
      .eq('status', 'new')
      .select('id')
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    if (!data) return NextResponse.json({ error: 'Candidate was already reviewed' }, { status: 409 });
    return NextResponse.json({ ok: true, status: 'rejected' });
  }

  const { data: position, error: acceptError } = await admin.rpc('accept_search_candidate', {
    p_contact_id: id,
    p_candidate_id: candidate.id,
    p_reviewer: auth.profile.id,
  });
  if (acceptError || !position) {
    const message = acceptError?.message ?? 'Could not accept candidate';
    const status = /filled|already|only new|search view/i.test(message) ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }

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
