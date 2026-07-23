import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { stopEnrollmentsFor } from '@/lib/sequence-runner';

// 1x1 transparent GIF
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** Open-tracking pixel: GET /api/track/open?m=<email_messages.id> */
export async function GET(request: Request) {
  const messageId = new URL(request.url).searchParams.get('m');

  if (messageId) {
    try {
      const admin = createAdminClient();
      const { data: message } = await admin
        .from('email_messages')
        .select('id, contact_id, open_count')
        .eq('id', messageId)
        .maybeSingle();

      if (message) {
        await admin
          .from('email_messages')
          .update({ open_count: message.open_count + 1 })
          .eq('id', message.id);
        await admin.from('email_events').insert({
          message_id: message.id,
          contact_id: message.contact_id,
          type: 'open',
        });
        if (message.contact_id) await stopEnrollmentsFor(message.contact_id, 'open');
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
