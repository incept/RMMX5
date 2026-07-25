import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { sendCrmEmail } from '@/lib/email-send';
import { renderTemplate } from '@/lib/sequence-runner';
import { deliveryKey, MAX_BULK_RECIPIENTS, validIdempotencyKey } from '@/lib/bulk-delivery';
import { enqueueJob } from '@/lib/job-queue';
import { readJsonBody, requestErrorResponse } from '@/lib/request-limits';

export async function POST(request: Request) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  let body: any;
  try {
    body = await readJsonBody(request, 512 * 1024);
  } catch (error) {
    const response = requestErrorResponse(error);
    return NextResponse.json({ error: response.message }, { status: response.status });
  }
  body.subject = String(body.subject ?? '').trim().slice(0, 500);
  body.html = String(body.html ?? '').slice(0, 250_000);

  if (!body.subject || !body.html) {
    return NextResponse.json({ error: 'subject and html required' }, { status: 400 });
  }

  const admin = createAdminClient();
  let accountId: string | null = null;
  if (body.accountId) {
    const { data: accessibleAccount } = await auth.supabase
      .from('email_accounts')
      .select('id')
      .eq('id', body.accountId)
      .maybeSingle();
    if (!accessibleAccount) {
      return NextResponse.json({ error: 'Email account not found or not accessible' }, { status: 403 });
    }
    accountId = accessibleAccount.id;
  } else {
    const { data: defaultAccount } = await auth.supabase
      .from('email_accounts')
      .select('id')
      .eq('is_default', true)
      .limit(1)
      .maybeSingle();
    accountId = defaultAccount?.id ?? null;
  }

  if (body.listId) {
    if (auth.profile.role !== 'admin') {
      return NextResponse.json({ error: 'Admin access required for list sends' }, { status: 403 });
    }
    const requestKey = request.headers.get('idempotency-key');
    if (!validIdempotencyKey(requestKey)) {
      return NextResponse.json({ error: 'A valid Idempotency-Key header is required' }, { status: 400 });
    }
    const { data: members, count, error } = await admin
      .from('email_list_members')
      .select('contacts ( id, name, email, city, state, custom )', { count: 'exact' })
      .eq('list_id', body.listId)
      .range(0, MAX_BULK_RECIPIENTS);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if ((count ?? 0) > MAX_BULK_RECIPIENTS) {
      return NextResponse.json(
        { error: `List sends are limited to ${MAX_BULK_RECIPIENTS} recipients per request` },
        { status: 413 }
      );
    }

    let queued = 0;
    let duplicates = 0;
    for (const member of (members ?? []) as any[]) {
      const contact = member.contacts;
      if (!contact?.email) continue;
      const key = deliveryKey('email', requestKey, contact.id);
      const result = await enqueueJob(
        'email_delivery',
        {
          to: contact.email,
          subject: renderTemplate(body.subject, contact),
          html: renderTemplate(body.html, contact, { html: true }),
          accountId,
          contactId: contact.id,
          actorId: auth.profile.id,
          deliveryKey: key,
        },
        `job:${key}`
      );
      if (result.queued) queued += 1;
      if (result.duplicate) duplicates += 1;
    }
    return NextResponse.json({ queued, duplicates }, { status: 202 });
  }

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
    html: contact ? renderTemplate(body.html, contact, { html: true }) : body.html,
    accountId,
    contactId: contact?.id ?? null,
    actorId: auth.profile.id,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ ok: true, messageId: result.messageRowId });
}
