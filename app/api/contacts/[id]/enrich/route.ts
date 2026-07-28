import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { enrichContactFromPhone } from '@/lib/enrichment';
import { logDebug, errorMessage } from '@/lib/debug-log';

type Params = { params: Promise<{ id: string }> };

// One provider call with a 15s internal timeout — safely inside this window.
export const maxDuration = 30;

/**
 * Admin-pressed reverse phone lookup. Unlike the queued auto-enrichment this
 * runs inline — the admin clicked a button and is waiting for the answer — and
 * it forces the lookup even when the contact already has a name and location,
 * because the point is to SEE what Trestle says about the number. Writes still
 * only ever fill blanks; a human-entered value is never overwritten.
 *
 * Admin-only on purpose: every press is a billed lookup, metered against the
 * same monthly cap as the automatic runs.
 */
export async function POST(_request: Request, { params }: Params) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const { id } = await params;

  try {
    const result = await enrichContactFromPhone(id, {
      actorId: auth.profile.id,
      force: true,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (e) {
    const message = errorMessage(e);
    await logDebug({
      level: 'error',
      source: 'trestle:manual',
      message: `Manual reverse lookup failed: ${message}`,
      contactId: id,
    }).catch(() => {});
    return NextResponse.json({ error: `Reverse lookup failed: ${message}` }, { status: 502 });
  }
}
