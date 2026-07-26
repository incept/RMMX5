import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { enqueueJob } from '@/lib/job-queue';
import { logDebug, errorMessage } from '@/lib/debug-log';

type Params = { params: Promise<{ id: string }> };

export const maxDuration = 15;

/** Enqueues deep search; expensive browser/provider work never lives in this request. */
export async function POST(_request: Request, { params }: Params) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const { id } = await params;

  try {
    const { data: contact } = await auth.supabase
      .from('contacts')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });

    // Collapse repeat clicks while still allowing a fresh sweep in a later hour.
    const hour = Math.floor(Date.now() / 3_600_000);
    const result = await enqueueJob(
      'deep_search',
      { contactId: id, actorId: auth.profile.id },
      `deep-search:${id}:${hour}`,
      2
    );
    return NextResponse.json(
      { ...result, status: result.duplicate ? 'already queued' : 'queued' },
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
