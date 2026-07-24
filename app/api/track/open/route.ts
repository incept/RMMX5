import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { stopEnrollmentsFor } from '@/lib/sequence-runner';
import { isTrackableId, passesCooldown } from '@/lib/track-guard';

// 1x1 transparent GIF
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** Open-tracking pixel: GET /api/track/open?m=<email_messages.id> */
export async function GET(request: Request) {
  const messageId = new URL(request.url).searchParams.get('m');

  if (isTrackableId(messageId) && passesCooldown(`open:${messageId}`)) {
    try {
      const admin = createAdminClient();
      // Atomic increment (no read-modify-write race); returns contact_id so
      // the event insert needs no second lookup. Empty result = unknown id.
      const { data } = await admin
        .rpc('track_email_event', { p_message_id: messageId, p_event: 'open' })
        .maybeSingle<{ message_id: string; contact_id: string | null }>();

      if (data) {
        await admin.from('email_events').insert({
          message_id: data.message_id,
          contact_id: data.contact_id,
          type: 'open',
        });
        if (data.contact_id) await stopEnrollmentsFor(data.contact_id, 'open');
      }
    } catch {
      // tracking must never fail the image response
    }
  }

  return new NextResponse(PIXEL, {
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
