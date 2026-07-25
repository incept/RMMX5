import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { enqueueJob } from '@/lib/job-queue';

type Params = { params: Promise<{ id: string }> };

export const maxDuration = 15;

/** Enqueues deep search; expensive browser/provider work never lives in this request. */
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
}
