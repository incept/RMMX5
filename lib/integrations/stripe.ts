import { getSetting } from '@/lib/settings';
import { readResponseText } from '@/lib/request-limits';

/**
 * Read-only Stripe revenue reporting via the REST API (no SDK needed).
 * Docs: https://docs.stripe.com/api/balance_transactions/list
 * Pulls recent charge balance transactions and buckets net revenue by month.
 */
export interface RevenueMonth {
  month: string; // YYYY-MM
  gross: number;
  net: number;
  count: number;
}

export async function fetchStripeRevenue(): Promise<{
  months: RevenueMonth[];
  currency: string;
  truncated: boolean;
}> {
  const cfg = await getSetting<{ secret_key?: string }>('stripe');
  if (!cfg.secret_key) throw new Error('Stripe is not configured (Admin → Integrations).');

  const months = new Map<string, RevenueMonth>();
  let currency = 'usd';
  let startingAfter: string | undefined;
  let truncated = false;

  // Up to 500 transactions (5 pages) — plenty for a dashboard view.
  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({ limit: '100', type: 'charge' });
    if (startingAfter) params.set('starting_after', startingAfter);

    const res = await fetch(`https://api.stripe.com/v1/balance_transactions?${params}`, {
      headers: { Authorization: `Bearer ${cfg.secret_key}` },
      signal: AbortSignal.timeout(20_000),
    });
    const responseText = await readResponseText(res, 1024 * 1024);
    if (!res.ok) throw new Error(`Stripe request failed: ${res.status} ${responseText.slice(0, 500)}`);
    const data = JSON.parse(responseText);
    for (const txn of data.data ?? []) {
      currency = txn.currency ?? currency;
      const month = new Date(txn.created * 1000).toISOString().slice(0, 7);
      const bucket = months.get(month) ?? { month, gross: 0, net: 0, count: 0 };
      bucket.gross += txn.amount / 100;
      bucket.net += txn.net / 100;
      bucket.count += 1;
      months.set(month, bucket);
    }

    if (!data.has_more || !data.data?.length) break;
    if (page === 4) truncated = true;
    startingAfter = data.data[data.data.length - 1].id;
  }

  return {
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    currency,
    truncated,
  };
}
