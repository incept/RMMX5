import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { sendCrmEmail } from '@/lib/email-send';
import { renderTemplate } from '@/lib/sequence-runner';

/**
 * POST — compose/send from the unified inbox or blast a list.
 * Body: { to?, contactId?, listId?, accountId?, subject, html }
 * Exactly one of `to`/`contactId` (single send) or `listId` (blast).
 * {{placeholders}} are rendered per contact.
 */
export async function POST(request: Request) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const body = await request.json();

  if (!body.subject || !body.html) {
    return NextResponse.json({ error: 'subject and html required' }, { status: 400 });
  }

  const admin = createAdminClient();

  // List blast
  if (body.listId) {
    const { data: members } = await admin
      .from('email_list_members')
      .select('contacts ( id, name, email, city, state, custom )')
      .eq('list_id', body.listId);

    let sent = 0;
    let failed = 0;
    for (const member of (members ?? []) as any[]) {
      const contact = member.contacts;
      if (!contact?.email) continue;
      const result = await sendCrmEmail({
        to: contact.email,
        subject: renderTemplate(body.subject, contact),
        html: renderTemplate(body.html, contact),
        accountId: body.accountId ?? null,
        contactId: contact.id,
        actorId: auth.profile.id,
      });
      if (result.ok) sent += 1;
      else failed += 1;
    }
    return NextResponse.json({ sent, failed });
  }

  // Single send
  let to = body.to as string | undefined;
  let contact: any = null;
  if (body.contactId) {
    const { data } = await admin.from('contacts').select('*').eq('id', body.contactId).single();
    contact = data;
    to = to ?? contact?.email ?? undefined;
  }
  if (!to) return NextResponse.json({ error: 'No recipient' }, { status: 400 });

  const result = await sendCrmEmail({
    to,
    subject: contact ? renderTemplate(body.subject, contact) : body.subject,
    html: contact ? renderTemplate(body.html, contact) : body.html,
    accountId: body.accountId ?? null,
    contactId: contact?.id ?? null,
    actorId: auth.profile.id,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ ok: true, messageId: result.messageRowId });
}
