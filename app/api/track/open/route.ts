import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { stopEnrollmentsFor } from '@/lib/sequence-runner';
import { isTrackableId, passesCooldown } from '@/lib/track-guard';
import { verifyTrackingOpen } from '@/lib/signing';
import { logDebug, errorMessage } from '@/lib/debug-log';

// 1x1 transparent GIF
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** Open-tracking pixel: GET /api/track/open?m=<email_messages.id> */
export async function GET(request: Request) {
  const messageId = new URL(request.url).searchParams.get('m');
  const signature = new URL(request.url).searchParams.get('s');

  if (
    isTrackableId(messageId) &&
    verifyTrackingOpen(messageId, signature) &&
    passesCooldown(`open:${messageId}`)
  ) {
    try {
      const admin = createAdminClient();
      // Atomic increment (no read-modify-write race); returns contact_id so
      // the event insert needs no second lookup. Empty result = unknown id.
      const { data } = await admin
        .rpc('track_email_event_bounded', {
          p_message_id: messageId,
          p_event: 'open',
          p_url: null,
          p_bucket_seconds: 60,
        })
        .maybeSingle<{ message_id: string; contact_id: string | null; counted: boolean }>();

      if (data?.counted) {
        if (data.contact_id) await stopEnrollmentsFor(data.contact_id, 'open');
      }
    } catch (error) {
      // Tracking must never fail the image response — but swallowing it whole
      // meant open counts could drift for weeks with nothing to show for it.
      // Logged at warn: the recipient still gets their pixel, and we still know.
      await logDebug({
        level: 'warn',
        source: 'api:track/open',
        message: `Open tracking failed: ${errorMessage(error)}`,
        context: { messageId },
      }).catch(() => {});
    }
  }

  return new NextResponse(PIXEL, {
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
