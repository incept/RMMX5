import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { stopEnrollmentsFor } from '@/lib/sequence-runner';
import { verifyTrackingUrl, trackingSecretConfigured } from '@/lib/signing';
import { isTrackableId, passesCooldown } from '@/lib/track-guard';
import { logDebug, errorMessage } from '@/lib/debug-log';

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

  // A real-looking click: valid message id + an http(s) target. Signature is
  // what separates a link this app actually sent from an open-redirect probe.
  const looksReal = isTrackableId(messageId) && !!url && /^https?:\/\//i.test(url);
  const valid = looksReal && verifyTrackingUrl(messageId, url, sig);

  if (valid) {
    // The cooldown gates COUNTING, never the redirect — a user clicking the
    // same link twice must still land on the page both times.
    if (passesCooldown(`click:${messageId}:${url}`)) {
      try {
        const admin = createAdminClient();
        // Atomic increment (no read-modify-write race); returns contact_id so
        // the event insert needs no second lookup. Empty result = unknown id.
        const { data } = await admin
          .rpc('track_email_event_bounded', {
            p_message_id: messageId,
            p_event: 'click',
            p_url: url,
            p_bucket_seconds: 60,
          })
          .maybeSingle<{ message_id: string; contact_id: string | null; counted: boolean }>();

        if (data?.counted) {
          if (data.contact_id) await stopEnrollmentsFor(data.contact_id, 'click');
        }
      } catch (error) {
        // Tracking must never break the redirect — the recipient still reaches
        // the page. But a failure nobody records means click counts drift with no
        // symptom, so it is written down at warn rather than discarded.
        await logDebug({
          level: 'warn',
          source: 'api:track/click',
          message: `Click tracking failed: ${errorMessage(error)}`,
          context: { messageId },
        }).catch(() => {});
      }
    }
  } else if (looksReal && passesCooldown(`click:sigfail:${messageId}`)) {
    // A real message id + http(s) target whose signature does not verify. Same
    // root cause as the open-pixel case (a CRON_SECRET mismatch between the host
    // that signed the link and this one, or an &s= mangled in transit) — but
    // here it is worse than a lost count: the redirect is withheld, so the
    // recipient lands on the app root instead of the link's destination. Silent
    // before; now visible so the mismatch is diagnosable.
    await logDebug({
      level: 'warn',
      source: 'api:track/click',
      message: 'Click hit but its signature did not verify — not counted, redirect withheld',
      context: {
        messageId,
        hasSignature: !!sig,
        secretConfigured: trackingSecretConfigured(),
      },
    }).catch(() => {});
  }

  return NextResponse.redirect(valid ? url! : new URL('/', request.url));
}
