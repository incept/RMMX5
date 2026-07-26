import { NextResponse } from 'next/server';
import { getSetting } from '@/lib/settings';
import { verifyBearerSecret } from '@/lib/webhook-auth';
import { processCallScalerCall } from '@/lib/integrations/callscaler';
import { logDebug, errorMessage } from '@/lib/debug-log';
import { enqueueJob } from '@/lib/job-queue';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';

/**
 * CallScaler post-call webhook. In each call flow: AUTOMATIONS → webhook →
 *   URL:           https://yourdomain.com/api/webhooks/callscaler
 *   Custom header: Authorization: Bearer <webhook_secret>
 * (secret configured under Admin → Integrations → CallScaler).
 *
 * Use their "Wait for AI" mode so ai_category/transcription arrive in the
 * same event — immediate mode sends those fields as null, which disables the
 * spam screen.
 *
 * CallScaler requires a 200 within 10 seconds, so the auto Google search for
 * new contacts is persisted to the queue for the cron worker. Idempotency lives in processCallScalerCall
 * (unique call_id), so their 3-attempt retry policy cannot double-create.
 */
export async function POST(request: Request) {
  const cfg = await getSetting<{ webhook_secret?: string }>('callscaler');
  if (!verifyBearerSecret(request, cfg.webhook_secret)) {
    await logDebug({
      level: 'warn',
      source: 'webhook:callscaler',
      message: cfg.webhook_secret
        ? 'Rejected: Authorization header missing or secret did not match'
        : 'Rejected: no webhook secret configured (Admin → Integrations)',
      context: { has_authorization_header: !!request.headers.get('authorization') },
    });
    return NextResponse.json({ error: 'Invalid webhook authorization' }, { status: 401 });
  }

  let payload: Record<string, any>;
  try {
    payload = await readJsonBody(request, 1024 * 1024);
  } catch (error) {
    return apiFailure('api:webhooks/callscaler', error);
  }

  try {
    const result = await processCallScalerCall(payload);

    // A brand-new call contact is a phone number and little else — usually no
    // location, and often no name worth searching. Enrichment runs first and
    // chains the auto search itself once it has a real name, so the search is
    // not wasted on "Caller +1919…". Queued, never inline: CallScaler retries a
    // slow delivery, and a retried webhook is how one call became several
    // contacts before.
    if (result.createdContact && result.contactId) {
      await enqueueJob(
        'contact_enrichment',
        { contactId: result.contactId },
        `enrich:callscaler:${result.callId}`
      );
    }

    // Already-named callers still get searched directly; enrichment only chains
    // a search when it is the thing that supplied the name.
    if (result.searchContactId) {
      await enqueueJob(
        'auto_search',
        { contactId: result.searchContactId },
        `auto-search:callscaler:${result.callId}`
      );
    }

    return NextResponse.json({
      ok: true,
      duplicate: result.duplicate,
      contact_id: result.contactId ?? null,
      created_contact: result.createdContact ?? false,
      skipped: result.skipped ?? null,
    });
  } catch (e: any) {
    await logDebug({
      source: 'webhook:callscaler',
      message: errorMessage(e),
      context: {
        call_id: payload.call_id ?? null,
        caller_number: payload.caller_number ?? null,
      },
    });
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
