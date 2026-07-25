import { randomUUID } from 'crypto';
import { createAdminClient } from '@/lib/supabase/server';
import { getSetting } from '@/lib/settings';

export async function reserveUsage(opts: {
  provider: string;
  operation: string;
  requestKey?: string;
  quantity?: number;
  monthlyLimit?: number | null;
  metadata?: Record<string, unknown>;
}) {
  const requestKey = opts.requestKey ?? `${opts.provider}:${opts.operation}:${randomUUID()}`;
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc('reserve_usage_event', {
    p_provider: opts.provider,
    p_operation: opts.operation,
    p_request_key: requestKey,
    p_quantity: opts.quantity ?? 1,
    p_monthly_limit: opts.monthlyLimit ?? null,
    p_metadata: opts.metadata ?? {},
  });
  if (error || !data) throw new Error(error?.message ?? 'Could not reserve provider usage');
  return { id: data as string, requestKey };
}

export async function finishUsage(
  id: string,
  status: 'succeeded' | 'failed',
  error?: string
) {
  const supabase = createAdminClient();
  const { error: updateError } = await supabase
    .from('usage_events')
    .update({
      status,
      error: error?.slice(0, 2000) ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (updateError) throw new Error(updateError.message);
}

export async function getUsageSummary() {
  const supabase = createAdminClient();
  const start = new Date();
  start.setUTCMonth(start.getUTCMonth() - 12, 1);
  start.setUTCHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from('usage_events')
    .select('provider, operation, quantity, status, created_at')
    .gte('created_at', start.toISOString());
  if (error) throw new Error(error.message);

  // Per-call prices are entered by an admin (BrightData bills per request, and
  // the rate depends on the plan), so cost is derived here rather than guessed.
  const brightdata = await getSetting<{
    serp_cost?: number | string;
    unlocker_cost?: number | string;
  }>('brightdata');
  const price: Record<string, number> = {
    serp: Number(brightdata.serp_cost) || 0,
    brightdata_unlocker: Number(brightdata.unlocker_cost) || 0,
  };

  const summary: Record<string, Record<string, number>> = {};
  // Billed separately from the totals: a failed request usually still costs,
  // and a rising failed count is money buying nothing.
  const failed: Record<string, Record<string, number>> = {};
  for (const event of data ?? []) {
    const counter = event.provider === 'brightdata' && event.operation === 'serp'
      ? 'serp'
      : `${event.provider}_${event.operation}`;
    const month = event.created_at.slice(0, 7);
    summary[counter] ??= {};
    summary[counter][month] = (summary[counter][month] ?? 0) + event.quantity;
    if (event.status === 'failed') {
      failed[counter] ??= {};
      failed[counter][month] = (failed[counter][month] ?? 0) + event.quantity;
    }
  }

  // cost[counter][month], plus a per-month "total" across every counter, so the
  // admin page can show one figure for the month's provider spend.
  const cost: Record<string, Record<string, number>> = { total: {} };
  const round = (n: number) => Math.round(n * 100) / 100;
  for (const [counter, months] of Object.entries(summary)) {
    const rate = price[counter] ?? 0;
    if (!rate) continue;
    cost[counter] = {};
    for (const [month, count] of Object.entries(months)) {
      cost[counter][month] = round(count * rate);
      cost.total[month] = round((cost.total[month] ?? 0) + count * rate);
    }
  }

  return { ...summary, _failed: failed, _cost: cost, _price: price };
}
