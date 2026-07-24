import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { stopEnrollmentsFor } from '@/lib/sequence-runner';
import { verifyTrackingUrl } from '@/lib/signing';
import { isTrackableId, passesCooldown } from '@/lib/track-guard';

/**
 * Click tracking + redirect: GET /api/track/click?m=<message id>&u=<url>&s=<hmac>
 * Only redirects to URLs whose HMAC checks out (i.e. links this app actually
 * embedded in an email) — anything else bounces to the app root, so this
 * endpoint can't be used as an open redirect. Unsigned hits are not counted.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const messageId = params.get('m');
  const url = params.get('u');
  const sig = params.get('s');

  const valid =
    isTrackableId(messageId) &&
    !!url &&
    /^https?:\/\//i.test(url) &&
    verifyTrackingUrl(messageId, url, sig);

  // The cooldown gates COUNTING, never the redirect — a user clicking the
  // same link twice must still land on the page both times.
  if (valid && passesCooldown(`click:${messageId}:${url}`)) {
    try {
      const admin = createAdminClient();
      // Atomic increment (no read-modify-write race); returns contact_id so
      // the event insert needs no second lookup. Empty result = unknown id.
      const { data } = await admin
        .rpc('track_email_event', { p_message_id: messageId, p_event: 'click' })
        .maybeSingle<{ message_id: string; contact_id: string | null }>();

      if (data) {
        await admin.from('email_events').insert({
          message_id: data.message_id,
          contact_id: data.contact_id,
          type: 'click',
          url,
        });
        if (data.contact_id) await stopEnrollmentsFor(data.contact_id, 'click');
      }
    } catch {
      // tracking must never break the redirect
    }
  }

  return NextResponse.redirect(valid ? url! : new URL('/', request.url));
}
