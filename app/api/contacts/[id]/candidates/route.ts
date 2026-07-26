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
  clearLearnedFact,
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
 * DELETE — clear a contact's found LINKS.
 *
 * Scoped to links on purpose. Facts are cleared one at a time from the panel
 * instead, because they are not interchangeable: a wrong county is worth
 * throwing away while the middle name and booking date beside it are usually
 * right, and an all-or-nothing reset made the operator lose the good ones to
 * fix the bad one.
 *
 * Two things beyond the visible list still have to go, or "clear" would be a
 * lie — the next run would rebuild an identical set:
 *
 *   * every candidate URL is suppressed on later runs, INCLUDING rejected ones,
 *     so a URL dismissed for a reason that has since been fixed could never
 *     come back on its own;
 *   * the enqueue dedupe key is per contact per hour, so a re-run in the same
 *     hour would silently answer "already queued" and do nothing.
 *
 * ACCEPTED candidates are kept: each is the provenance record for a filled link
 * slot, so deleting one would orphan real work product and let an
 * already-accepted URL be suggested again. CONFIRMED candidates are kept for the
 * same reason — a human vouched for them. Link slots are never touched.
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

    // Facts are deliberately NOT reset here. They are cleared individually from
    // the panel, so a wrong county can go without taking a correct middle name
    // and booking date with it.

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
      description: `Cleared found links (${cleared} candidate${
        cleared === 1 ? '' : 's'
      } removed; facts kept)`,
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

  // Clear one fact FIELD — every learned value for that key. Scoped to a single
  // field because facts are not interchangeable: a wrong county is worth
  // discarding while the middle name and booking date beside it are usually
  // right, and the old all-or-nothing reset made you lose the good ones to fix
  // the bad one. Confirmed values are left alone; a human vouched for those and
  // they have their own remove control.
  if (action === 'clear_fact') {
    const adminAuth = await requireAdmin();
    if ('error' in adminAuth) return adminAuth.error;
    try {
      if (!isConfirmableKey(body.key)) {
        return NextResponse.json({ error: 'key must be a fact field' }, { status: 400 });
      }
      const { data: c, error: readError } = await admin
        .from('contacts')
        .select('search_facts')
        .eq('id', id)
        .maybeSingle();
      if (readError) throw readError;
      if (!c) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });

      const next = clearLearnedFact(c.search_facts, body.key);
      const { error: writeError } = await admin
        .from('contacts')
        .update({ search_facts: next })
        .eq('id', id);
      if (writeError) throw writeError;

      await logActivity({
        contactId: id,
        actorId: adminAuth.profile.id,
        type: 'updated',
        description: `Cleared found ${body.key} values`,
      });
      return NextResponse.json({ ok: true, search_facts: next });
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
