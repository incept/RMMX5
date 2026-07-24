import { createAdminClient } from '@/lib/supabase/server';
import { sendCrmEmail } from '@/lib/email-send';
import { sequenceFailureUpdate } from '@/lib/sequence-retry';

/**
 * Email sequence engine.
 *
 * A sequence = ordered steps (template + delay_days). Contacts are enrolled
 * manually, when added to the sequence's list (`list_added`), or when their
 * status changes into one of `start_status_ids` (`status_change`).
 *
 * Stop triggers (`stop_on`): open | click | reply | bounce | status_change.
 * When a matching event lands, the enrollment is stopped and no further
 * steps send. The cron endpoint calls processDueEnrollments() to deliver
 * whatever is due.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Render {{placeholders}} against a contact row.
 *
 * `html: true` escapes the SUBSTITUTED VALUES (never the template itself —
 * the admin's markup is trusted). Contact fields are attacker-supplied: a
 * form submission with `<a href=...>` in the name would otherwise be mailed
 * out as live markup under our sending domain. Subjects and SMS bodies are
 * plain text, so they render unescaped.
 */
export function renderTemplate(
  text: string,
  contact: Record<string, any>,
  opts?: { html?: boolean }
): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => {
    const value = contact[key] ?? contact.custom?.[key] ?? '';
    const str = value == null ? '' : String(value);
    return opts?.html ? str.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]) : str;
  });
}

export async function enrollContact(sequenceId: string, contactId: string) {
  const supabase = createAdminClient();
  const { data: firstStep } = await supabase
    .from('sequence_steps')
    .select('delay_days')
    .eq('sequence_id', sequenceId)
    .order('step_order')
    .limit(1)
    .maybeSingle();

  const delayMs = (firstStep?.delay_days ?? 0) * 24 * 60 * 60 * 1000;
  await supabase.from('sequence_enrollments').upsert(
    {
      sequence_id: sequenceId,
      contact_id: contactId,
      status: 'active',
      current_step: 0,
      next_send_at: new Date(Date.now() + delayMs).toISOString(),
      stop_reason: null,
      attempt_count: 0,
      last_error: null,
    },
    { onConflict: 'sequence_id,contact_id' }
  );
}

/**
 * Stops active enrollments for a contact in every sequence whose stop_on
 * includes the event. For status_change, the sequence's stop_status_ids
 * must be empty (any status) or contain the new status.
 */
export async function stopEnrollmentsFor(
  contactId: string,
  event: 'open' | 'click' | 'reply' | 'bounce' | 'status_change',
  newStatusId?: string
) {
  const supabase = createAdminClient();
  const { data: enrollments } = await supabase
    .from('sequence_enrollments')
    .select('id, sequence_id, email_sequences ( stop_on, stop_status_ids )')
    .eq('contact_id', contactId)
    .eq('status', 'active');

  for (const e of (enrollments ?? []) as any[]) {
    const seq = e.email_sequences;
    if (!seq?.stop_on?.includes(event)) continue;
    if (
      event === 'status_change' &&
      seq.stop_status_ids?.length > 0 &&
      (!newStatusId || !seq.stop_status_ids.includes(newStatusId))
    ) {
      continue;
    }
    await supabase
      .from('sequence_enrollments')
      .update({ status: 'stopped', stop_reason: event })
      .eq('id', e.id);
  }
}

/** Starts any active status_change sequences that target the new status. */
export async function startSequencesForStatus(contactId: string, newStatusId: string) {
  const supabase = createAdminClient();
  const { data: sequences } = await supabase
    .from('email_sequences')
    .select('id, start_status_ids')
    .eq('active', true)
    .eq('start_trigger', 'status_change');

  for (const seq of sequences ?? []) {
    if ((seq.start_status_ids ?? []).includes(newStatusId)) {
      await enrollContact(seq.id, contactId);
    }
  }
}

/** Called by the cron endpoint: sends every step that has come due. */
export async function processDueEnrollments(): Promise<{ sent: number; errors: number }> {
  const supabase = createAdminClient();
  let sent = 0;
  let errors = 0;

  const { data: due, error: claimError } = await supabase.rpc(
    'claim_due_sequence_enrollments',
    { p_limit: 25 }
  );
  if (claimError) throw claimError;

  for (const enrollment of (due ?? []) as any[]) {
    try {
      const [{ data: sequence }, { data: steps }, { data: contact }] = await Promise.all([
        supabase.from('email_sequences').select('*').eq('id', enrollment.sequence_id).single(),
        supabase
          .from('sequence_steps')
          .select('*, email_templates ( subject, html )')
          .eq('sequence_id', enrollment.sequence_id)
          .order('step_order'),
        supabase.from('contacts').select('*').eq('id', enrollment.contact_id).single(),
      ]);

      if (!sequence?.active || !contact?.email) {
        await supabase
          .from('sequence_enrollments')
          .update({ status: 'stopped', stop_reason: !sequence?.active ? 'sequence_inactive' : 'no_email' })
          .eq('id', enrollment.id);
        continue;
      }

      const nextStep = (steps ?? [])[enrollment.current_step];
      if (!nextStep) {
        await supabase
          .from('sequence_enrollments')
          .update({ status: 'completed', next_send_at: null })
          .eq('id', enrollment.id);
        continue;
      }

      const template = (nextStep as any).email_templates;
      const result = await sendCrmEmail({
        to: contact.email,
        subject: renderTemplate(template?.subject ?? '', contact),
        html: renderTemplate(template?.html ?? '', contact, { html: true }),
        accountId: sequence.send_account_id,
        contactId: contact.id,
        sequenceId: sequence.id,
        sequenceStepId: nextStep.id,
      });

      if (!result.ok) {
        errors += 1;
        await supabase
          .from('sequence_enrollments')
          .update(
            sequenceFailureUpdate(
              enrollment.attempt_count ?? 0,
              result.error ?? 'Email delivery failed'
            )
          )
          .eq('id', enrollment.id);
        continue;
      }
      sent += 1;

      const following = (steps ?? [])[enrollment.current_step + 1];
      await supabase
        .from('sequence_enrollments')
        .update(
          following
            ? {
                current_step: enrollment.current_step + 1,
                attempt_count: 0,
                last_error: null,
                next_send_at: new Date(
                  Date.now() + following.delay_days * 24 * 60 * 60 * 1000
                ).toISOString(),
              }
            : {
                current_step: enrollment.current_step + 1,
                attempt_count: 0,
                last_error: null,
                status: 'completed',
                next_send_at: null,
              }
        )
        .eq('id', enrollment.id);
    } catch (error: any) {
      errors += 1;
      await supabase
        .from('sequence_enrollments')
        .update(
          sequenceFailureUpdate(
            enrollment.attempt_count ?? 0,
            error?.message ?? 'Unexpected sequence processing failure'
          )
        )
        .eq('id', enrollment.id);
    }
  }

  return { sent, errors };
}
