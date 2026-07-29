import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { enqueueJob } from '@/lib/job-queue';
import { readJsonBody } from '@/lib/request-limits';
import { logDebug, errorMessage } from '@/lib/debug-log';

type Params = { params: Promise<{ id: string }> };

export const maxDuration = 15;

/** Enqueues deep search; expensive browser/provider work never lives in this request. */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const { id } = await params;

  try {
    // Optional body: { focusDate: 'yyyy-mm-dd' } branches out ONE arrest of a
    // multi-arrest person — that date drives every window and date-built URL.
    // The body is absent on a plain run, so a parse failure means unfocused.
    const body = await readJsonBody(request, 4 * 1024).catch(() => ({}) as any);
    const focusDate =
      typeof body?.focusDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.focusDate)
        ? body.focusDate
        : null;

    const { data: contact } = await auth.supabase
      .from('contacts')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });

    // Collapse repeat clicks while still allowing a fresh sweep in a later
    // hour. A focused run keys on its date too: branching three arrests
    // back-to-back is the intended use, not a repeat click.
    const hour = Math.floor(Date.now() / 3_600_000);
    const result = await enqueueJob(
      'deep_search',
      { contactId: id, actorId: auth.profile.id, ...(focusDate ? { focusDate } : {}) },
      `deep-search:${id}:${hour}${focusDate ? `:${focusDate}` : ''}`,
      2
    );
    // The grid's search icon turns amber on this stamp; the run clears it when
    // it concludes. Set even on a duplicate — either way a run is in flight.
    // Service role, since requireAdmin already gated the caller and a client-
    // side RLS denial here would be silent. Best-effort: a missing stamp must
    // not fail the enqueue.
    const shouldStamp = result.queued || ['pending', 'processing'].includes(result.status ?? '');
    const { error: stampError } = shouldStamp
      ? await createAdminClient()
          .from('contacts')
          .update({
            deep_search_queued_at: new Date().toISOString(),
            deep_search_job_id: result.id ?? null,
          })
          .eq('id', id)
      : { error: null };
    if (stampError) {
      await logDebug({
        source: 'deep-search:enqueue',
        message: `Could not stamp the queue time (migration 0025 run?): ${stampError.message}`,
        contactId: id,
      });
    }
    return NextResponse.json(
      {
        ...result,
        status:
          result.duplicate && result.status === 'completed'
            ? 'already completed this hour'
            : result.duplicate
              ? 'already queued'
              : 'queued',
      },
      { status: result.duplicate ? 200 : 202 }
    );
  } catch (e) {
    // Without this, a throw here returns a bare 500 carrying no JSON, so the
    // operator sees "HTTP 500" and the cause exists only in a server log they
    // cannot reach. Deep search was dead for a day behind exactly that gap:
    // the database had said precisely what was wrong the whole time.
    const message = errorMessage(e);
    await logDebug({
      level: 'error',
      source: 'deep-search:enqueue',
      message: `Could not start deep search: ${message}`,
      contactId: id,
    }).catch(() => {});
    return NextResponse.json(
      { error: `Could not start deep search: ${message}` },
      { status: 500 }
    );
  }
}
