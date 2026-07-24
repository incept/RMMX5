import { randomUUID } from 'crypto';
import { createAdminClient } from '@/lib/supabase/server';

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
    .select('provider, operation, quantity, created_at')
    .gte('created_at', start.toISOString());
  if (error) throw new Error(error.message);

  const summary: Record<string, Record<string, number>> = {};
  for (const event of data ?? []) {
    const counter = event.provider === 'brightdata' && event.operation === 'serp'
      ? 'serp'
      : `${event.provider}_${event.operation}`;
    const month = event.created_at.slice(0, 7);
    summary[counter] ??= {};
    summary[counter][month] = (summary[counter][month] ?? 0) + event.quantity;
  }
  return summary;
}
