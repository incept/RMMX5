import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { renderTemplate } from '@/lib/sequence-runner';
import { withLinkPlaceholders } from '@/lib/link-placeholders';
import { deliveryKey, MAX_BULK_RECIPIENTS, validIdempotencyKey } from '@/lib/bulk-delivery';
import { enqueueJob } from '@/lib/job-queue';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import { sanitizeEmailHtml } from '@/lib/html-sanitize';

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  let body: any;
  try {
    body = await readJsonBody(request, 512 * 1024);
  } catch (error) {
    return apiFailure('api:email/send', error);
  }
  body.subject = String(body.subject ?? '').trim().slice(0, 500);
  // Rich-editor / ad-hoc compose HTML enters here; strip executable constructs
  // before it is stored and mailed. Placeholders ({{name}}) are plain text and
  // pass through untouched. Sequence/campaign template sends don't hit this
  // route — those are sanitized at template-save time.
  body.html = sanitizeEmailHtml(String(body.html ?? '').slice(0, 250_000));

  if (!body.subject || !body.html) {
    return NextResponse.json({ error: 'subject and html required' }, { status: 400 });
  }

  const admin = createAdminClient();
  let accountId: string | null = null;
  if (body.accountId) {
    const { data: accessibleAccount } = await auth.supabase
      .from('email_accounts_safe')
      .select('id')
      .eq('id', body.accountId)
      .maybeSingle();
    if (!accessibleAccount) {
      return NextResponse.json({ error: 'Email account not found or not accessible' }, { status: 403 });
    }
    accountId = accessibleAccount.id;
  } else {
    const { data: defaultAccount } = await auth.supabase
      .from('email_accounts_safe')
      .select('id')
      .eq('is_default', true)
      .limit(1)
      .maybeSingle();
    accountId = defaultAccount?.id ?? null;
  }

  if (body.listId) {
    if (!['admin', 'super_admin'].includes(auth.profile.role)) {
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
      const rendered = await withLinkPlaceholders(admin, contact, body.subject, body.html);
      const key = deliveryKey('email', requestKey, contact.id);
      const result = await enqueueJob(
        'email_delivery',
        {
          to: contact.email,
          subject: renderTemplate(body.subject, rendered),
          html: renderTemplate(body.html, rendered, { html: true }),
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
  if (auth.profile.role === 'worker') {
    if (!contact?.email) {
      return NextResponse.json(
        { error: 'Workers may only send email to an existing CRM contact' },
        { status: 403 }
      );
    }
    if (to.trim().toLowerCase() !== String(contact.email).trim().toLowerCase()) {
      return NextResponse.json(
        { error: 'Recipient must match the selected CRM contact' },
        { status: 403 }
      );
    }
    to = contact.email;
  }
  const requestKey = request.headers.get('idempotency-key');
  if (!validIdempotencyKey(requestKey)) {
    return NextResponse.json({ error: 'A valid Idempotency-Key header is required' }, { status: 400 });
  }
  const recipient = String(to);
  const recipientKey = contact?.id ?? recipient.trim().toLowerCase();
  const key = deliveryKey('email', requestKey, recipientKey);
  const rendered = contact ? await withLinkPlaceholders(admin, contact, body.subject, body.html) : null;
  const queued = await enqueueJob(
    'email_delivery',
    {
      to: recipient,
      subject: rendered ? renderTemplate(body.subject, rendered) : body.subject,
      html: rendered ? renderTemplate(body.html, rendered, { html: true }) : body.html,
      accountId,
      contactId: contact?.id ?? null,
      actorId: auth.profile.id,
      deliveryKey: key,
      appendToSent: true,
    },
    `job:${key}`
  );
  return NextResponse.json(queued, { status: 202 });
}
