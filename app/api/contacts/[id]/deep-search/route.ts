import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { enqueueDeepSearchJob } from '@/lib/job-queue';
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
    // Optional body: { focusDate: 'yyyy-mm-dd' } branches out one arrest of a
    // multi-arrest person. No body means an ordinary unfocused run. A present
    // but malformed body must not silently change the operator's request.
    const body = request.body ? await readJsonBody(request, 4 * 1024) : {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      const error = new Error('Deep-search payload must be a JSON object') as Error & {
        status?: number;
      };
      error.status = 400;
      throw error;
    }
    if (
      'focusDate' in body &&
      (typeof body.focusDate !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(body.focusDate))
    ) {
      const error = new Error('focusDate must use yyyy-mm-dd') as Error & { status?: number };
      error.status = 400;
      throw error;
    }
    const focusDate = typeof body.focusDate === 'string' ? body.focusDate : null;

    const { data: contact, error: contactError } = await auth.supabase
      .from('contacts')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (contactError) throw new Error(`Could not verify contact: ${contactError.message}`);
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });

    // Collapse repeat clicks while allowing a fresh sweep in a later hour.
    // Focused runs include the date because branching several arrests
    // back-to-back is intentional.
    const hour = Math.floor(Date.now() / 3_600_000);
    const result = await enqueueDeepSearchJob({
      contactId: id,
      actorId: auth.profile.id,
      focusDate,
      dedupeKey: `deep-search:${id}:${hour}${focusDate ? `:${focusDate}` : ''}`,
      maxAttempts: 2,
    });

    // Queue insertion and the contact's amber stamp are one transaction. The
    // route never acknowledges work whose visible state failed to persist.
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
    const message = errorMessage(e);
    const explicitStatus = Number((e as { status?: number } | null)?.status);
    const status =
      Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus < 500
        ? explicitStatus
        : 500;
    await logDebug({
      level: status < 500 ? 'warn' : 'error',
      source: 'deep-search:enqueue',
      message: `Could not start deep search: ${message}`,
      contactId: id,
    });
    return NextResponse.json(
      { error: `Could not start deep search: ${message}` },
      { status }
    );
  }
}
