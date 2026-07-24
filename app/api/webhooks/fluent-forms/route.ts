import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getSetting } from '@/lib/settings';
import { processFluentFormsLead } from '@/lib/lead-intake';
import { verifyBearerSecret } from '@/lib/webhook-auth';
import { claimWebhookReceipt, releaseWebhookReceipt } from '@/lib/webhook-receipts';
import { logDebug, errorMessage } from '@/lib/debug-log';

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
    // The most common setup mistake — surfaced so it is visible in Admin →
    // Debug Log instead of being an opaque 401 on the WordPress side.
    await logDebug({
      level: 'warn',
      source: 'webhook:fluent-forms',
      message: cfg.webhook_secret
        ? 'Rejected: Authorization header missing or secret did not match'
        : 'Rejected: no webhook secret configured (Admin → Integrations)',
      context: { has_authorization_header: !!request.headers.get('authorization') },
    });
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
  if (!eventId) {
    return NextResponse.json(
      { error: 'A stable entry_id, submission_id, or x-rmmx-idempotency-key is required' },
      { status: 400 }
    );
  }
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
      error: errorMessage(e),
    });
    await logDebug({
      source: 'webhook:fluent-forms',
      message: errorMessage(e),
      context: { event_id: eventId, payload_keys: Object.keys(payload ?? {}) },
    });
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
