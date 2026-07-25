import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { runDeepSearchForContact } from '@/lib/deep-search';
import { errorMessage } from '@/lib/debug-log';

type Params = { params: Promise<{ id: string }> };

// Probes run sequentially with a politeness delay, so a full two-round sweep
// can take a couple of minutes.
export const maxDuration = 300;

/**
 * POST — run the probe-first deep search for one contact, on demand.
 *
 * Results land in search_candidates for review; nothing fills a link slot
 * automatically. The cron worker runs the same routine from the job queue.
 */
export async function POST(_request: Request, { params }: Params) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const { id } = await params;

  try {
    const result = await runDeepSearchForContact(id, auth.profile.id);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 400 });
  }
}
