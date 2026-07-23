import { createAdminClient } from '@/lib/supabase/server';

/**
 * App settings live in the `settings` table (admin-only RLS) as one jsonb
 * value per key. This module is the only reader — always server-side, via
 * the service-role client, so API keys never reach the browser.
 *
 * Known keys and their shapes (all optional until an admin fills them in):
 *   brightdata    { api_key, serp_zone, proxy_zone, proxy_username, proxy_password }
 *   emailit       { api_key, from_address, from_name }
 *   textlink      { api_key, sim_card_id }
 *   stripe        { secret_key }
 *   fluent_forms  { webhook_secret }
 *   voicemail     { provider_url, api_key, caller_id }
 *   search        { country, num_results, extra_terms }
 *   defaults      { service_days }
 */
export async function getSetting<T = Record<string, any>>(key: string): Promise<T> {
  const supabase = createAdminClient();
  const { data } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
  return ((data?.value ?? {}) as T);
}

export async function setSetting(key: string, value: Record<string, any>, updatedBy?: string) {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from('settings')
    .upsert({ key, value, updated_by: updatedBy ?? null, updated_at: new Date().toISOString() });
  if (error) throw error;
}
