import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { stopEnrollmentsFor } from '@/lib/sequence-runner';
import { verifyTrackingUrl } from '@/lib/signing';

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
    !!messageId && !!url && /^https?:\/\//i.test(url) && verifyTrackingUrl(messageId, url, sig);

  if (valid) {
    try {
      const admin = createAdminClient();
      const { data: message } = await admin
        .from('email_messages')
        .select('id, contact_id, click_count')
        .eq('id', messageId)
        .maybeSingle();

      if (message) {
        await admin
          .from('email_messages')
          .update({ click_count: message.click_count + 1 })
          .eq('id', message.id);
        await admin.from('email_events').insert({
          message_id: message.id,
          contact_id: message.contact_id,
          type: 'click',
          url,
        });
        if (message.contact_id) await stopEnrollmentsFor(message.contact_id, 'click');
      }
    } catch {
      // tracking must never break the redirect
    }
  }

  return NextResponse.redirect(valid ? url! : new URL('/', request.url));
}
