import { createAdminClient } from '@/lib/supabase/server';
import { enqueueJob } from '@/lib/job-queue';
import { getSetting, setSetting } from '@/lib/settings';

/**
 * Admin-configurable client notifications (notification_rules):
 *   link_status_change — a tracked link flips live/requested/removed
 *   status_change      — the contact's CRM status changes
 *   client_countdown   — N days left in the service period (fired by cron)
 *
 * Rules define channels (email/SMS), whether they apply to clients only,
 * and a message template with {{placeholders}}.
 */

function render(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) =>
    vars[key] != null ? String(vars[key]) : ''
  );
}

async function isClient(contact: any): Promise<boolean> {
  if (!contact.status_id) return false;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('statuses')
    .select('is_client_status')
    .eq('id', contact.status_id)
    .single();
  if (error) throw new Error(error.message);
  return !!data?.is_client_status;
}

export async function fireNotification(
  event: 'link_status_change' | 'status_change' | 'client_countdown',
  contact: any,
  vars: Record<string, string | number>,
  options?: { ruleId?: string; dedupeKey?: string }
) {
  const supabase = createAdminClient();
  let rulesQuery = supabase
    .from('notification_rules')
    .select('*')
    .eq('event', event)
    .eq('enabled', true);
  if (options?.ruleId) rulesQuery = rulesQuery.eq('id', options.ruleId);
  const { data: rules, error: rulesError } = await rulesQuery;
  if (rulesError) throw new Error(rulesError.message);

  if (!rules?.length) return;

  const clientCheck = await isClient(contact);

  for (const rule of rules) {
    if (rule.clients_only && !clientCheck) continue;

    const message = render(rule.template, { name: contact.name, ...vars });

    for (const channel of rule.channels as string[]) {
      const dedupeKey = options?.dedupeKey ? `${options.dedupeKey}:${channel}` : null;
      const { data: reservation, error: reservationError } = await supabase
        .from('notifications_log')
        .insert({
          contact_id: contact.id,
          rule_id: rule.id,
          channel,
          message,
          status: 'pending',
          dedupe_key: dedupeKey,
        })
        .select('id')
        .single();
      // A unique-key collision means another cron worker already reserved it.
      if (reservationError?.code === '23505') continue;
      if (reservationError || !reservation) {
        throw new Error(reservationError?.message ?? 'Could not reserve notification');
      }

      try {
        const destination = channel === 'email' ? contact.email : contact.phone;
        await enqueueJob(
          'notification_delivery',
          {
            notificationId: reservation.id,
            channel,
            destination: destination ?? null,
            message,
          },
          `notification:${reservation.id}`
        );
      } catch (e: any) {
        const { error: cleanupError } = await supabase
          .from('notifications_log')
          .delete()
          .eq('id', reservation.id);
        if (cleanupError) {
          throw new Error(`${e.message}; notification cleanup failed: ${cleanupError.message}`);
        }
        throw e;
      }
    }
  }
}

/**
 * Cron helper: for every client with a countdown, fire the client_countdown
 * rule when days-left hits one of the rule's configured thresholds.
 * De-duped per (contact, threshold) via notifications_log.
 */
export async function processCountdownNotifications(limit = 250) {
  const supabase = createAdminClient();

  const { data: rules } = await supabase
    .from('notification_rules')
    .select('id, config')
    .eq('event', 'client_countdown')
    .eq('enabled', true);
  if (!rules?.length) return { checked: 0 };

  const defaults = await getSetting<{ service_days?: number | string }>('defaults');
  const defaultDays = Number(defaults.service_days ?? 90);
  const scan = await getSetting<{ last_id?: string | null }>('countdown_scan', { fresh: true });
  let clientsQuery = supabase
    .from('contacts')
    .select('id, name, email, phone, status_id, client_since, service_days')
    .not('client_since', 'is', null)
    .order('id')
    .limit(Math.min(Math.max(limit, 1), 500));
  if (scan.last_id) clientsQuery = clientsQuery.gt('id', scan.last_id);
  const { data: clients, error: clientsError } = await clientsQuery;
  if (clientsError) throw new Error(clientsError.message);

  let checked = 0;
  for (const contact of clients ?? []) {
    const totalDays = contact.service_days ?? defaultDays;
    const elapsed = Math.floor((Date.now() - new Date(contact.client_since).getTime()) / 86400000);
    const daysLeft = totalDays - elapsed;
    checked += 1;

    for (const rule of rules) {
      const thresholds: number[] = rule.config?.days_before ?? [7, 1];
      if (!thresholds.includes(daysLeft)) continue;

      await fireNotification(
        'client_countdown',
        contact,
        { days_left: daysLeft },
        {
          ruleId: rule.id,
          dedupeKey: `countdown:${rule.id}:${contact.id}:${contact.client_since}:${daysLeft}`,
        }
      );
    }
  }
  const lastId = clients?.at(-1)?.id ?? null;
  await setSetting('countdown_scan', {
    last_id: clients?.length === Math.min(Math.max(limit, 1), 500) ? lastId : null,
  });
  return { checked, has_more: !!lastId && clients?.length === Math.min(Math.max(limit, 1), 500) };
}
