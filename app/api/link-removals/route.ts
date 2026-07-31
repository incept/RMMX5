import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Admin confirmation queue: client removal links the re-check scan flagged as
 * gone (3 consecutive reads). Nothing here is auto-applied — the operator
 * confirms the flip to 'removed' or dismisses a false positive.
 */
export async function GET() {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const admin = createAdminClient();
  try {
    const { data, error } = await admin
      .from('contact_links')
      .select('id, url, gone_streak, last_checked_at, updated_at, contact_id, contacts ( id, name )')
      .eq('removal_detected', true)
      .eq('status', 'requested')
      .order('updated_at', { ascending: true })
      .limit(500);
    if (error) throw error;
    return NextResponse.json({
      candidates: (data ?? []).map((l: any) => ({
        id: l.id,
        url: l.url,
        goneStreak: l.gone_streak,
        lastCheckedAt: l.last_checked_at,
        detectedAt: l.updated_at,
        contact: { id: l.contact_id, name: l.contacts?.name ?? null },
      })),
    });
  } catch (error) {
    return apiFailure('api:link-removals', error);
  }
}

/**
 * Confirm (flip requested -> removed and fire the client "link removed" alert)
 * or dismiss (clear detection, keep it requested, re-arm the cadence).
 */
export async function POST(request: Request) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;

  let body: any;
  try {
    body = await readJsonBody(request, 4096);
  } catch (error) {
    return apiFailure('api:link-removals', error);
  }
  const linkId = String(body?.linkId ?? '');
  const action = String(body?.action ?? '');
  if (!UUID.test(linkId)) {
    return NextResponse.json({ error: 'A valid linkId is required' }, { status: 400 });
  }
  if (action !== 'confirm' && action !== 'dismiss') {
    return NextResponse.json({ error: 'action must be "confirm" or "dismiss"' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc(
    action === 'confirm' ? 'confirm_link_removal' : 'dismiss_link_removal',
    { p_link_id: linkId, p_actor_id: auth.user.id }
  );
  if (error) {
    // The RPC raises when the link is no longer an open candidate (someone else
    // already acted on it) — surface that as a conflict, not a 500.
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  return NextResponse.json({ ok: true, link: data });
}
