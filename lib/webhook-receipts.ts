import { createAdminClient } from '@/lib/supabase/server';

/** Returns false when this provider event was already accepted. */
export async function claimWebhookReceipt(provider: string, eventId: string | null | undefined) {
  if (!eventId) return true;
  const admin = createAdminClient();
  const { error } = await admin.from('webhook_receipts').insert({
    provider,
    event_id: String(eventId).slice(0, 500),
  });
  if (!error) return true;
  if (error.code === '23505') return false;
  throw error;
}

/** A failed handler releases its receipt so the provider's retry can run. */
export async function releaseWebhookReceipt(provider: string, eventId: string | null | undefined) {
  if (!eventId) return;
  await createAdminClient()
    .from('webhook_receipts')
    .delete()
    .eq('provider', provider)
    .eq('event_id', String(eventId).slice(0, 500));
}
