import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { enqueueImapSyncNow } from '@/lib/integrations/imap-sync';
import { apiFailure } from '@/lib/api-errors';

export const runtime = 'nodejs';

/**
 * Manual refresh: enqueue an immediate IMAP pull for every receiving account.
 * The periodic sync runs every ~3 min; this is the refresh button's "check now".
 * The pull itself runs on the VPS heavy lane; new mail arrives via Realtime.
 */
export async function POST() {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  try {
    const result = await enqueueImapSyncNow();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return apiFailure('api:inbox/sync', error);
  }
}
