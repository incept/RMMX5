import { NextResponse } from 'next/server';
import { requireAdmin, requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { applyScores } from '@/lib/scoring';
import { logActivity } from '@/lib/activity';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import { canonicalUrl } from '@/lib/integrations/brightdata';
import { splitName } from '@/lib/deep-search/facts';
import {
  addConfirmedFact,
  confirmFactsFromUrl,
  isConfirmableKey,
  removeConfirmedFact,
} from '@/lib/deep-search/confirmed';

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

/**
 * DELETE — clear a contact's deep-search results so the next run starts fresh.
 *
 * This has to remove more than the visible list, because the list is not what
 * makes a re-run repeat itself. Three things persist between runs:
 *
 *   * every candidate URL is suppressed on later runs, INCLUDING rejected ones,
 *     so a URL dismissed for a reason that has since been fixed can never come
 *     back on its own;
 *   * search_facts only ever accumulates. Correcting a contact's state does not
 *     evict the old one, and a stale county keeps steering probes and keeps
 *     adding corroboration to strangers who happen to match it;
 *   * the enqueue dedupe key is per contact per hour, so a re-run in the same
 *     hour silently answers "already queued" and does nothing.
 *
 * Clearing only the rows the operator can see would leave all three in place and
 * produce an identical result set, which is the opposite of what "clear" means.
 *
 * ACCEPTED candidates are deliberately kept: each one is the provenance record
 * for a filled link slot, so deleting it would orphan real work product and let
 * an already-accepted URL be suggested again. Link slots are never touched.
 */
export async function DELETE(_request: Request, { params }: Params) {
  // Admin-only, matching the deep-search route that produces this data. It is
  // irreversible, and the review queue is somebody's work.
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const { id } = await params;

  const admin = createAdminClient();
  try {
    // Clearing under a live run is racy: the run would insert candidates after
    // the delete and reinstate the facts we just reset, leaving a half-state
    // nobody asked for. Refuse instead, and say why.
    const { data: running } = await admin
      .from('job_queue')
      .select('id')
      .eq('kind', 'deep_search')
      .eq('status', 'processing')
      .eq('payload->>contactId', id)
      .maybeSingle();
    if (running) {
      return NextResponse.json(
        { error: 'A deep search is running for this contact. Try again once it finishes.' },
        { status: 409 }
      );
    }

    const { data: removed, error: deleteError } = await admin
      .from('search_candidates')
      .delete()
      .eq('contact_id', id)
      .in('status', ['new', 'rejected'])
      .select('id');
    if (deleteError) throw deleteError;

    const { error: factsError } = await admin
      .from('contacts')
      .update({ search_facts: {} })
      .eq('id', id);
    if (factsError) throw factsError;

    // Free the hourly dedupe key so the operator can re-run straight away —
    // clearing results and then being told "already queued" would be absurd.
    // Anything mid-flight was ruled out above.
    const { error: jobError } = await admin
      .from('job_queue')
      .delete()
      .eq('kind', 'deep_search')
      .eq('payload->>contactId', id)
      .neq('status', 'processing');
    if (jobError) throw jobError;

    const cleared = removed?.length ?? 0;
    await logActivity({
      contactId: id,
      actorId: auth.profile.id,
      type: 'updated',
      description: `Cleared deep-search results (${cleared} candidate${
        cleared === 1 ? '' : 's'
      } removed, learned facts reset)`,
    });
    return NextResponse.json({ ok: true, cleared });
  } catch (error) {
    return apiFailure('api:contacts/[id]/candidates', error, { contactId: id });
  }
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
  const admin = createAdminClient();

  // Confirming a FACT or a pasted URL touches confirmed_facts, not a candidate,
  // so these branches run before the candidate lookup. All are admin-only: this
  // is asserting truth the engine will act on, matching the deep-search route.
  if (action === 'confirm_fact' || action === 'unconfirm_fact') {
    const adminAuth = await requireAdmin();
    if ('error' in adminAuth) return adminAuth.error;
    try {
      if (!isConfirmableKey(body.key) || typeof body.value !== 'string' || !body.value.trim()) {
        return NextResponse.json(
          { error: 'key (a fact field) and a non-empty value are required' },
          { status: 400 }
        );
      }
      const { data: c, error: readError } = await admin
        .from('contacts')
        .select('confirmed_facts')
        .eq('id', id)
        .maybeSingle();
      if (readError) throw readError;
      if (!c) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });

      const next =
        action === 'confirm_fact'
          ? addConfirmedFact(c.confirmed_facts, body.key, body.value)
          : removeConfirmedFact(c.confirmed_facts, body.key, body.value);
      const { error: writeError } = await admin
        .from('contacts')
        .update({ confirmed_facts: next })
        .eq('id', id);
      if (writeError) throw writeError;

      await logActivity({
        contactId: id,
        actorId: adminAuth.profile.id,
        type: 'updated',
        description: `${action === 'confirm_fact' ? 'Confirmed' : 'Unconfirmed'} ${body.key} "${body.value.trim()}"`,
      });
      return NextResponse.json({ ok: true, confirmed_facts: next });
    } catch (error) {
      return apiFailure('api:contacts/[id]/candidates', error, { contactId: id });
    }
  }

  if (action === 'confirm_url') {
    const adminAuth = await requireAdmin();
    if ('error' in adminAuth) return adminAuth.error;
    try {
      const raw = typeof body.url === 'string' ? body.url.trim() : '';
      if (!/^https?:\/\/\S+$/i.test(raw) || raw.length > 2048) {
        return NextResponse.json({ error: 'A valid HTTP(S) URL is required' }, { status: 400 });
      }
      const { data: c, error: readError } = await admin
        .from('contacts')
        .select('name, confirmed_facts')
        .eq('id', id)
        .maybeSingle();
      if (readError) throw readError;
      if (!c) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });

      const name = splitName(c.name ?? '');
      // Derive the URL's facts into the same authoritative store a confirmed
      // fact lands in — the whole reason a confirmed link is worth anything.
      const next = confirmFactsFromUrl(c.confirmed_facts, raw, name);
      const { error: writeError } = await admin
        .from('contacts')
        .update({ confirmed_facts: next })
        .eq('id', id);
      if (writeError) throw writeError;

      // Record the URL so it shows in the list and, being in search_candidates,
      // is suppressed from re-surfacing on later runs. onConflict handles a URL
      // a probe already found: promote it to confirmed rather than erroring.
      const { error: upsertError } = await admin.from('search_candidates').upsert(
        {
          contact_id: id,
          url: raw,
          canonical_url: canonicalUrl(raw),
          source: 'manual',
          source_detail: 'confirmed by hand',
          confidence: 1,
          status: 'confirmed',
          reviewed_by: adminAuth.profile.id,
          reviewed_at: new Date().toISOString(),
        },
        { onConflict: 'contact_id,canonical_url' }
      );
      if (upsertError) throw upsertError;

      await logActivity({
        contactId: id,
        actorId: adminAuth.profile.id,
        type: 'updated',
        description: `Confirmed URL as this person's: ${raw}`,
        meta: { url: raw },
      });
      return NextResponse.json({ ok: true, status: 'confirmed', confirmed_facts: next });
    } catch (error) {
      return apiFailure('api:contacts/[id]/candidates', error, { contactId: id });
    }
  }

  if (!body.candidateId || (action !== 'accept' && action !== 'reject' && action !== 'confirm')) {
    return NextResponse.json(
      { error: 'candidateId and action (accept, reject, or confirm) are required' },
      { status: 400 }
    );
  }

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

  // Confirm a found candidate as truth WITHOUT spending a removal slot: promote
  // its status and fold its URL's facts into confirmed_facts. A search view is
  // not a person's record page, so it cannot be confirmed as one.
  if (action === 'confirm') {
    const adminAuth = await requireAdmin();
    if ('error' in adminAuth) return adminAuth.error;
    if (candidate.matched_facts?.kind === 'site_search') {
      return NextResponse.json(
        { error: 'A search view is not a record page and cannot be confirmed' },
        { status: 409 }
      );
    }
    try {
      const { data: c, error: readError } = await admin
        .from('contacts')
        .select('name, confirmed_facts')
        .eq('id', id)
        .maybeSingle();
      if (readError) throw readError;
      if (!c) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });

      const name = splitName(c.name ?? '');
      const next = confirmFactsFromUrl(c.confirmed_facts, candidate.url, name);
      const { error: writeError } = await admin
        .from('contacts')
        .update({ confirmed_facts: next })
        .eq('id', id);
      if (writeError) throw writeError;

      // Only from new/rejected: an accepted candidate owns a link slot, and
      // flipping it to confirmed would strand that slot's provenance.
      const { data: updated, error: statusError } = await admin
        .from('search_candidates')
        .update({
          status: 'confirmed',
          reviewed_by: adminAuth.profile.id,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', candidate.id)
        .in('status', ['new', 'rejected'])
        .select('id')
        .maybeSingle();
      if (statusError) throw statusError;
      if (!updated) {
        return NextResponse.json(
          { error: 'Candidate is already accepted into a slot; confirm does not apply' },
          { status: 409 }
        );
      }

      await logActivity({
        contactId: id,
        actorId: adminAuth.profile.id,
        type: 'updated',
        description: `Confirmed candidate as this person's: ${candidate.url}`,
        meta: { url: candidate.url },
      });
      return NextResponse.json({ ok: true, status: 'confirmed', confirmed_facts: next });
    } catch (error) {
      return apiFailure('api:contacts/[id]/candidates', error, { contactId: id });
    }
  }

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
