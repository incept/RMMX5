import { createAdminClient } from '@/lib/supabase/server';

/**
 * App settings live in the `settings` table (admin-only RLS) as one jsonb
 * value per key. This module is the only reader — always server-side, via
 * the service-role client, so API keys never reach the browser.
 *
 * Known keys and their shapes (all optional until an admin fills them in):
 *   brightdata    { api_key, serp_zone, monthly_limit, proxy_zone, proxy_username, proxy_password }
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
 * Usage events and cron leases live in dedicated tables.
 */

const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 32;
const cache = new Map<string, { value: any; at: number }>();

/**
 * Cached for 30s per process: one auto-search alone reads settings 5+ times
 * (BrightData twice, search twice, ip-api), and every webhook reads its
 * secret — each was a DB round-trip. setSetting refreshes this process's
 * cache immediately; other processes converge within the TTL, which every
 * caller tolerates (webhook secrets, engine config, cron cursors).
 *
 * Pass { fresh: true } for cursors and other state that must bypass the cache.
 */
export async function getSetting<T = Record<string, any>>(
  key: string,
  opts?: { fresh?: boolean }
): Promise<T> {
  if (!opts?.fresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
    if (hit) cache.delete(key);
  }
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) throw error;
  const value = (data?.value ?? {}) as T;
  cache.set(key, { value, at: Date.now() });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
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
