import { NextResponse } from 'next/server';
import { processDueEnrollments } from '@/lib/sequence-runner';
import { processCountdownNotifications } from '@/lib/notifications';
import { safeEqual } from '@/lib/signing';

/**
 * The heartbeat. Call it every 5–15 minutes from any scheduler:
 *   curl "https://yourdomain.com/api/cron/tick?secret=YOUR_CRON_SECRET"
 *
 * Each tick: sends due sequence emails and fires client-countdown
 * notifications. Both are idempotent, so over-calling is harmless.
 */
export async function GET(request: Request) {
  const secret = new URL(request.url).searchParams.get('secret');
  if (!process.env.CRON_SECRET || !secret || !safeEqual(secret, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Invalid secret' }, { status: 401 });
  }

  const sequences = await processDueEnrollments();
  const countdown = await processCountdownNotifications();

  return NextResponse.json({ ok: true, sequences, countdown, at: new Date().toISOString() });
}
