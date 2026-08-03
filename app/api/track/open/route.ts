import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { stopEnrollmentsFor } from '@/lib/sequence-runner';
import { isTrackableId, passesCooldown } from '@/lib/track-guard';
import { verifyTrackingOpen, trackingSecretConfigured } from '@/lib/signing';
import { logDebug, errorMessage } from '@/lib/debug-log';

// 1x1 transparent GIF
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function pixelResponse() {
  return new NextResponse(PIXEL, {
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}

/** Open-tracking pixel: GET /api/track/open?m=<email_messages.id> */
export async function GET(request: Request) {
  const messageId = new URL(request.url).searchParams.get('m');
  const signature = new URL(request.url).searchParams.get('s');

  // Only real message ids (past the cooldown) get further attention; scanner
  // junk and prefetch bursts are shed here before any logging or DB work.
  if (isTrackableId(messageId) && passesCooldown(`open:${messageId}`)) {
    if (!verifyTrackingOpen(messageId, signature)) {
      // A genuine pixel hit whose signature does not verify almost always means
      // the CRON_SECRET that SIGNED the link differs from the one VERIFYING it
      // (e.g. the web host and the worker that delivered the mail don't share a
      // secret), or the &s= was mangled in transit. This was silent before, so
      // opens simply never counted with nothing in the log to explain why.
      await logDebug({
        level: 'warn',
        source: 'api:track/open',
        message: 'Open pixel hit but its signature did not verify — open not counted',
        context: {
          messageId,
          hasSignature: !!signature,
          secretConfigured: trackingSecretConfigured(),
        },
      }).catch(() => {});
      return pixelResponse();
    }
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

  return pixelResponse();
}
