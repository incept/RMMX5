import { NextResponse, after } from 'next/server';
import { getSetting } from '@/lib/settings';
import { verifyBearerSecret } from '@/lib/webhook-auth';
import { processCallScalerCall, runCallSearch } from '@/lib/integrations/callscaler';
import { logDebug, errorMessage } from '@/lib/debug-log';

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
 * new contacts is deferred with `after()` — the response returns first, the
 * search runs once it is sent. Idempotency lives in processCallScalerCall
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
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Unparseable payload' }, { status: 400 });
  }

  try {
    const result = await processCallScalerCall(payload);

    if (result.searchContactId) {
      const contactId = result.searchContactId;
      after(() => runCallSearch(contactId));
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
