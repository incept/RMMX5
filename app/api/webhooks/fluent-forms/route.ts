import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getSetting } from '@/lib/settings';
import { processFluentFormsLead } from '@/lib/lead-intake';

/**
 * Fluent Forms webhook — point the form's webhook feed at:
 *   POST https://yourdomain.com/api/webhooks/fluent-forms?secret=<webhook_secret>
 * (secret configured under Admin → Integrations → Fluent Forms).
 *
 * Creates the contact, then runs the automatic Google search / link scoring.
 */
export async function POST(request: Request) {
  const cfg = await getSetting<{ webhook_secret?: string }>('fluent_forms');
  const secret = new URL(request.url).searchParams.get('secret');
  if (!cfg.webhook_secret || secret !== cfg.webhook_secret) {
    return NextResponse.json({ error: 'Invalid secret' }, { status: 401 });
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
  try {
    const { contact, search } = await processFluentFormsLead(payload);
    await admin.from('webhook_leads').insert({
      payload,
      contact_id: contact.id,
      status: 'processed',
    });
    return NextResponse.json({ ok: true, contact_id: contact.id, search });
  } catch (e: any) {
    await admin.from('webhook_leads').insert({
      payload,
      status: 'failed',
      error: e.message,
    });
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
