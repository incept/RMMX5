import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { stopEnrollmentsFor } from '@/lib/sequence-runner';

/** Click tracking + redirect: GET /api/track/click?m=<message id>&u=<url> */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const messageId = params.get('m');
  const url = params.get('u');

  // Only redirect to http(s) URLs — anything else falls back to the app root.
  const target = url && /^https?:\/\//i.test(url) ? url : '/';

  if (messageId) {
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
          url: target,
        });
        if (message.contact_id) await stopEnrollmentsFor(message.contact_id, 'click');
      }
    } catch {
      // tracking must never break the redirect
    }
  }

  return NextResponse.redirect(target);
}
