import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { fetchStripeRevenue } from '@/lib/integrations/stripe';

/**
 * GET — dashboard revenue block:
 *   * projection: sum of per-contact revenue_projection (computed from
 *     live links × url_rules removal prices)
 *   * stripe: actual revenue by month (if Stripe is configured)
 *
 * ADMIN ONLY. Revenue and Stripe figures are not for worker accounts, and
 * this endpoint aggregates every contact's projection plus company-wide
 * monthly gross — so the guard lives here, not only in the UI that hides it.
 */
export async function GET() {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;

  const admin = createAdminClient();
  const { data: contacts } = await admin
    .from('contacts')
    .select('id, name, revenue_projection, client_since')
    .gt('revenue_projection', 0)
    .order('revenue_projection', { ascending: false })
    .limit(50);

  const projectionTotal = (contacts ?? []).reduce(
    (sum, c) => sum + Number(c.revenue_projection ?? 0),
    0
  );

  let stripe: any = null;
  let stripeError: string | null = null;
  try {
    stripe = await fetchStripeRevenue();
  } catch (e: any) {
    stripeError = e.message;
  }

  return NextResponse.json({
    projectionTotal: Math.round(projectionTotal * 100) / 100,
    topProjections: contacts ?? [],
    stripe,
    stripeError,
  });
}
