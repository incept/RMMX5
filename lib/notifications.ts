import { createAdminClient } from '@/lib/supabase/server';
import { sendViaEmailit } from '@/lib/integrations/emailit';
import { sendSms } from '@/lib/integrations/textlink';
import { notificationRetryUpdate } from '@/lib/notification-retry';

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
  const { data } = await supabase
    .from('statuses')
    .select('is_client_status')
    .eq('id', contact.status_id)
    .single();
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
  const { data: rules } = await rulesQuery;

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
          attempt_count: 0,
          next_retry_at: null,
        })
        .select('id, attempt_count')
        .single();
      let activeReservation = reservation;
      if (reservationError?.code === '23505' && dedupeKey) {
        const { data: retry } = await supabase
          .from('notifications_log')
          .update({ status: 'pending', error: null, next_retry_at: null })
          .eq('dedupe_key', dedupeKey)
          .eq('status', 'failed')
          .lt('attempt_count', 5)
          .or(`next_retry_at.is.null,next_retry_at.lte.${new Date().toISOString()}`)
          .select('id, attempt_count')
          .maybeSingle();
        activeReservation = retry;
      }
      // A sent/pending collision means another worker already owns or completed it.
      if (reservationError && reservationError.code !== '23505') continue;
      if (!activeReservation) continue;

      let status: 'sent' | 'failed' = 'sent';
      let error: string | undefined;

      try {
        if (channel === 'email' && contact.email) {
          const r = await sendViaEmailit({
            to: contact.email,
            subject: 'Update on your case',
            html: `<p>${message}</p>`,
          });
          if (!r.ok) {
            status = 'failed';
            error = r.error;
          }
        } else if (channel === 'sms' && contact.phone) {
          const r = await sendSms(contact.phone, message);
          if (!r.ok) {
            status = 'failed';
            error = r.error;
          }
        } else {
          status = 'failed';
          error = `No ${channel === 'email' ? 'email address' : 'phone number'} on file`;
        }
      } catch (e: any) {
        status = 'failed';
        error = e.message;
      }

      const retryUpdate =
        status === 'failed'
          ? notificationRetryUpdate(activeReservation.attempt_count ?? 0, error)
          : { status: 'sent' as const, error: null, next_retry_at: null };
      await supabase
        .from('notifications_log')
        .update(retryUpdate)
        .eq('id', activeReservation.id);
    }
  }
}

/**
 * Cron helper: for every client with a countdown, fire the client_countdown
 * rule when days-left hits one of the rule's configured thresholds.
 * De-duped per (contact, threshold) via notifications_log.
 */
export async function processCountdownNotifications() {
  const supabase = createAdminClient();

  const { data: rules } = await supabase
    .from('notification_rules')
    .select('*')
    .eq('event', 'client_countdown')
    .eq('enabled', true);
  if (!rules?.length) return { checked: 0 };

  const { data: settingsRow } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'defaults')
    .maybeSingle();
  const defaultDays = Number(settingsRow?.value?.service_days ?? 90);

  const { data: clients } = await supabase
    .from('contacts')
    .select('*')
    .not('client_since', 'is', null);

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
  return { checked };
}
