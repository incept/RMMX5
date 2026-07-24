import { createAdminClient } from '@/lib/supabase/server';

/**
 * App settings live in the `settings` table (admin-only RLS) as one jsonb
 * value per key. This module is the only reader — always server-side, via
 * the service-role client, so API keys never reach the browser.
 *
 * Known keys and their shapes (all optional until an admin fills them in):
 *   brightdata    { api_key, serp_zone, proxy_zone, proxy_username, proxy_password }
 *   emailit       { api_key, from_address, from_name, webhook_signing_secret }
 *   textlink      { api_key, sim_card_id }
 *   stripe        { secret_key }
 *   fluent_forms  { webhook_secret }
 *   callscaler    { api_key, webhook_secret }
 *   callscaler_sync { updated_since }   -- cron cursor; not admin-editable
 *   inbound_email { webhook_secret }
 *   voicemail     { provider_url, api_key, caller_id }
 *   search        { country, num_results, extra_terms }
 *   defaults      { service_days }
 *   usage         { serp: { "2026-07": n } } -- SERP request counter; not admin-editable
 *   cron_lock     { started_at }        -- tick overlap guard; not admin-editable
 */

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: any; at: number }>();

/**
 * Cached for 30s per process: one auto-search alone reads settings 5+ times
 * (BrightData twice, search twice, ip-api), and every webhook reads its
 * secret — each was a DB round-trip. setSetting refreshes this process's
 * cache immediately; other processes converge within the TTL, which every
 * caller tolerates (webhook secrets, engine config, cron cursors).
 *
 * Pass { fresh: true } for read-modify-write cycles (counters, cursors)
 * where a stale read would lose data.
 */
export async function getSetting<T = Record<string, any>>(
  key: string,
  opts?: { fresh?: boolean }
): Promise<T> {
  if (!opts?.fresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  }
  const supabase = createAdminClient();
  const { data } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
  const value = (data?.value ?? {}) as T;
  cache.set(key, { value, at: Date.now() });
  return value;
}

export async function setSetting(key: string, value: Record<string, any>, updatedBy?: string) {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from('settings')
    .upsert({ key, value, updated_by: updatedBy ?? null, updated_at: new Date().toISOString() });
  if (error) throw error;
  cache.set(key, { value, at: Date.now() });
}

/**
 * Best-effort monthly usage counter (e.g. SERP requests, so BrightData spend
 * is visible instead of a mystery). Read-modify-write on a fresh read;
 * concurrent processes may drop the occasional increment, which is fine for
 * a spend gauge. Never throws — metering must not break the metered call.
 */
export async function bumpUsageCounter(counter: string, by = 1) {
  try {
    const usage = await getSetting<Record<string, Record<string, number>>>('usage', {
      fresh: true,
    });
    const month = new Date().toISOString().slice(0, 7); // "2026-07"
    const series = usage[counter] ?? {};
    series[month] = (series[month] ?? 0) + by;
    await setSetting('usage', { ...usage, [counter]: series });
  } catch {
    // ignore
  }
}
