import { NextResponse, after } from 'next/server';
import { createHash } from 'crypto';
import { createAdminClient } from '@/lib/supabase/server';
import { getSetting } from '@/lib/settings';
import {
  processFluentFormsLead,
  runAutoSearchSafely,
  extractFluentFormsEventId,
} from '@/lib/lead-intake';
import { verifyBearerSecret } from '@/lib/webhook-auth';
import { claimWebhookReceipt, releaseWebhookReceipt } from '@/lib/webhook-receipts';
import { logDebug, errorMessage } from '@/lib/debug-log';

/**
 * Fluent Forms webhook — point the form's webhook feed at:
 *   POST https://yourdomain.com/api/webhooks/fluent-forms
 * with Authorization: Bearer <webhook_secret>.
 * (secret configured under Admin → Integrations → Fluent Forms).
 *
 * Creates the contact and answers immediately; the automatic web search runs
 * after the response via after(). Answering fast matters: WordPress's HTTP
 * client times out in seconds, marks a slow delivery as failed, and RETRIES —
 * which, combined with a missing idempotency key, is how one submission became
 * up to four contacts. Every delivery is therefore deduped on the Fluent Forms
 * entry id, falling back to a hash of the payload (a retry re-sends the
 * identical body) when no id can be found.
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

  // Fluent Forms nests its entry id under flat dotted keys, so the old
  // top-level payload.entry_id lookup always came back null — and a null key
  // disables deduping entirely. The payload hash backstops setups whose feed
  // sends no id at all: retries resend the identical body, so they collapse.
  const eventId =
    request.headers.get('x-rmmx-idempotency-key') ??
    extractFluentFormsEventId(payload) ??
    'sha256:' + createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const claimed = await claimWebhookReceipt('fluent_forms', eventId);
  if (!claimed) return NextResponse.json({ ok: true, duplicate: true });

  try {
    const { contact } = await processFluentFormsLead(payload);
    await admin.from('webhook_leads').insert({
      payload,
      contact_id: contact.id,
      status: 'processed',
    });
    // Search AFTER the response: two SERP engines can take 10–60s, far past
    // the sender's timeout. Failures inside are logged + flag the contact.
    after(() => runAutoSearchSafely(contact.id));
    return NextResponse.json({ ok: true, contact_id: contact.id, search: 'deferred' });
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
