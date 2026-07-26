import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { enqueueJob } from '@/lib/job-queue';
import { apiFailure } from '@/lib/api-errors';

type Params = { params: Promise<{ id: string }> };

/** Enqueues a metered Google/Bing search instead of retaining an HTTP worker. */
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

    const window = Math.floor(Date.now() / (5 * 60_000));
    const result = await enqueueJob(
      'auto_search',
      { contactId: id, actorId: auth.profile.id },
      `manual-auto-search:${id}:${window}`,
      2
    );
    return NextResponse.json(
      { ...result, status: result.duplicate ? 'already queued' : 'queued' },
      { status: result.duplicate ? 200 : 202 }
    );
  } catch (error) {
    // Same shape as the deep-search route, and the same trap: an unguarded
    // throw here returns a bare 500 with no body, so the button reports a
    // status code and the cause is recorded nowhere.
    return apiFailure('api:contacts/[id]/search', error, { contactId: id });
  }
}
