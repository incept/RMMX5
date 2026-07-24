import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getSetting } from '@/lib/settings';
import { processFluentFormsLead } from '@/lib/lead-intake';
import { verifyBearerSecret } from '@/lib/webhook-auth';
import { claimWebhookReceipt, releaseWebhookReceipt } from '@/lib/webhook-receipts';

/**
 * Fluent Forms webhook — point the form's webhook feed at:
 *   POST https://yourdomain.com/api/webhooks/fluent-forms
 * with Authorization: Bearer <webhook_secret>.
 * (secret configured under Admin → Integrations → Fluent Forms).
 *
 * Creates the contact, then runs the automatic Google search / link scoring.
 */
export async function POST(request: Request) {
  const cfg = await getSetting<{ webhook_secret?: string }>('fluent_forms');
  if (!verifyBearerSecret(request, cfg.webhook_secret)) {
    return NextResponse.json({ error: 'Invalid webhook authorization' }, { status: 401 });
  }

  let payload: Record<string, any>;
  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      payload = await request.json();
    } else {
      payload = Object.fromEntries((await request.formData()).entries()) as Record<string, any>;
    }
  } catch {
    return NextResponse.json({ error: 'Unparseable payload' }, { status: 400 });
  }

  const admin = createAdminClient();
  const eventId =
    request.headers.get('x-rmmx-idempotency-key') ??
    payload.entry_id ??
    payload.submission_id ??
    payload.data?.entry_id ??
    null;
  const claimed = await claimWebhookReceipt('fluent_forms', eventId);
  if (!claimed) return NextResponse.json({ ok: true, duplicate: true });

  try {
    const { contact, search } = await processFluentFormsLead(payload);
    await admin.from('webhook_leads').insert({
      payload,
      contact_id: contact.id,
      status: 'processed',
    });
    return NextResponse.json({ ok: true, contact_id: contact.id, search });
  } catch (e: any) {
    await releaseWebhookReceipt('fluent_forms', eventId);
    await admin.from('webhook_leads').insert({
      payload,
      status: 'failed',
      error: e.message,
    });
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
