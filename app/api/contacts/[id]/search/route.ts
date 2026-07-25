import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { enqueueJob } from '@/lib/job-queue';

type Params = { params: Promise<{ id: string }> };

/** Enqueues a metered Google/Bing search instead of retaining an HTTP worker. */
export async function POST(_request: Request, { params }: Params) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const { id } = await params;

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
}
