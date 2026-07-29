import { createAdminClient } from '@/lib/supabase/server';
import { errorMessage, logDebug } from '@/lib/debug-log';

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
    | 'call'
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
    const { error } = await supabase.from('activity_log').insert({
      contact_id: entry.contactId ?? null,
      actor_id: entry.actorId ?? null,
      type: entry.type,
      description: entry.description,
      meta: entry.meta ?? {},
    });
    if (error) throw error;
  } catch (error) {
    // Activity is not allowed to break the action, but losing the only
    // human-readable run summary must be visible in Admin → Debug Log.
    await logDebug({
      level: 'warn',
      source: 'activity-log',
      message: `Could not record ${entry.type} activity: ${errorMessage(error)}`,
      context: { contact_id: entry.contactId ?? null },
      contactId: entry.contactId ?? null,
    });
  }
}
