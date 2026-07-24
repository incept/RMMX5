import { NextResponse } from 'next/server';
import { processDueEnrollments } from '@/lib/sequence-runner';
import { processCountdownNotifications } from '@/lib/notifications';
import { verifyBearerSecret } from '@/lib/webhook-auth';

/**
 * The heartbeat. Call it every 5–15 minutes from any scheduler:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     "https://yourdomain.com/api/cron/tick"
 *
 * Each tick: sends due sequence emails and fires client-countdown
 * notifications. Both are idempotent, so over-calling is harmless.
 */
export async function GET(request: Request) {
  if (!verifyBearerSecret(request, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Invalid secret' }, { status: 401 });
  }

  const sequences = await processDueEnrollments();
  const countdown = await processCountdownNotifications();

  return NextResponse.json({ ok: true, sequences, countdown, at: new Date().toISOString() });
}
