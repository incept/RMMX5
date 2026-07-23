import { createAdminClient } from '@/lib/supabase/server';

/**
 * Appends one entry to the activity log. Fire-and-forget from the caller's
 * perspective — a logging failure never breaks the action being logged.
 */
export async function logActivity(entry: {
  contactId?: string | null;
  actorId?: string | null; // null/undefined = system (cron, webhook)
  type:
    | 'created'
    | 'updated'
    | 'status_change'
    | 'link_change'
    | 'email'
    | 'sms'
    | 'voicemail'
    | 'note'
    | 'import'
    | 'search'
    | 'file';
  description: string;
  meta?: Record<string, any>;
}) {
  try {
    const supabase = createAdminClient();
    await supabase.from('activity_log').insert({
      contact_id: entry.contactId ?? null,
      actor_id: entry.actorId ?? null,
      type: entry.type,
      description: entry.description,
      meta: entry.meta ?? {},
    });
  } catch {
    // never let logging break the main flow
  }
}
