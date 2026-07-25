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

/**
 * Finishing the ledger must never turn a provider success into a provider retry.
 * The cron reconciler marks stale reservations failed, while this returns false
 * and emits a server log if the accounting write itself is unavailable.
 */
export async function finishUsage(
  id: string,
  status: 'succeeded' | 'failed',
  error?: string,
  metadata?: Record<string, unknown>
): Promise<boolean> {
  try {
    const { data, error: updateError } = await createAdminClient().rpc('finish_usage_event', {
      p_id: id,
      p_status: status,
      p_error: error?.slice(0, 2000) ?? null,
      p_metadata: metadata ?? {},
    });
    if (updateError || data !== true) {
      throw new Error(updateError?.message ?? 'Usage event was not found');
    }
    return true;
  } catch (finishError) {
    console.error('Could not finish provider usage event', {
      id,
      status,
      error: finishError instanceof Error ? finishError.message : String(finishError),
    });
    return false;
  }
}

type UsageAggregate = {
  provider: string;
  operation: string;
  month: string;
  status: 'attempted' | 'succeeded' | 'failed';
  quantity: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
};

export async function getUsageSummary() {
  const supabase = createAdminClient();
  const start = new Date();
  start.setUTCMonth(start.getUTCMonth() - 12, 1);
  start.setUTCHours(0, 0, 0, 0);
  const { data, error } = await supabase.rpc('usage_summary_since', {
    p_since: start.toISOString(),
  });
  if (error) throw new Error(error.message);

  const [brightdata, anthropic] = await Promise.all([
    getSetting<{ serp_cost?: number | string; unlocker_cost?: number | string }>('brightdata'),
    getSetting<{
      input_cost_per_million?: number | string;
      output_cost_per_million?: number | string;
    }>('anthropic'),
  ]);
  const price: Record<string, number> = {
    serp: Number(brightdata.serp_cost) || 0,
    brightdata_unlocker: Number(brightdata.unlocker_cost) || 0,
    anthropic_input_per_million: Number(anthropic.input_cost_per_million) || 0,
    anthropic_output_per_million: Number(anthropic.output_cost_per_million) || 0,
  };

  const summary: Record<string, Record<string, number>> = {};
  const failed: Record<string, Record<string, number>> = {};
  const succeeded: Record<string, Record<string, number>> = {};
  const tokens: Record<string, Record<string, { input: number; output: number }>> = {};
  const rows = (data ?? []) as UsageAggregate[];
  for (const event of rows) {
    const counter =
      event.provider === 'brightdata' && event.operation === 'serp'
        ? 'serp'
        : `${event.provider}_${event.operation}`;
    const quantity = Number(event.quantity) || 0;
    summary[counter] ??= {};
    summary[counter][event.month] = (summary[counter][event.month] ?? 0) + quantity;
    const bucket =
      event.status === 'failed' ? failed : event.status === 'succeeded' ? succeeded : null;
    if (bucket) {
      bucket[counter] ??= {};
      bucket[counter][event.month] = (bucket[counter][event.month] ?? 0) + quantity;
    }
    if (event.status === 'succeeded' && event.provider === 'anthropic') {
      tokens[counter] ??= {};
      tokens[counter][event.month] ??= { input: 0, output: 0 };
      tokens[counter][event.month].input += Number(event.input_tokens) || 0;
      tokens[counter][event.month].output += Number(event.output_tokens) || 0;
    }
  }

  const cost: Record<string, Record<string, number>> = { total: {} };
  const round = (n: number) => Math.round(n * 10000) / 10000;
  for (const [counter, months] of Object.entries(succeeded)) {
    const rate = price[counter] ?? 0;
    if (!rate) continue;
    cost[counter] = {};
    for (const [month, count] of Object.entries(months)) {
      cost[counter][month] = round(count * rate);
      cost.total[month] = round((cost.total[month] ?? 0) + count * rate);
    }
  }
  for (const [counter, months] of Object.entries(tokens)) {
    cost[counter] ??= {};
    for (const [month, usage] of Object.entries(months)) {
      const amount =
        (usage.input / 1_000_000) * price.anthropic_input_per_million +
        (usage.output / 1_000_000) * price.anthropic_output_per_million;
      cost[counter][month] = round(amount);
      cost.total[month] = round((cost.total[month] ?? 0) + amount);
    }
  }

  return {
    ...summary,
    _failed: failed,
    _succeeded: succeeded,
    _tokens: tokens,
    _cost: cost,
    _price: price,
  };
}
