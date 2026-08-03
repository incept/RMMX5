import { createAdminClient } from '@/lib/supabase/server';
import { sendCrmEmail } from '@/lib/email-send';
import { sequenceFailureUpdate } from '@/lib/sequence-retry';
import { renderTemplate } from '@/lib/render-template';
import { withLinkPlaceholders } from '@/lib/link-placeholders';

// Re-exported so existing importers (the send route, tests) keep working after
// the pure implementation moved to lib/render-template.ts.
export { renderTemplate };

/**
 * Email sequence engine.
 *
 * A sequence = ordered steps (inline email or template + delay_days). Contacts are enrolled
 * manually, when added to the sequence's list (`list_added`), or when their
 * status changes into one of `start_status_ids` (`status_change`).
 *
 * Stop triggers (`stop_on`): open | click | reply | bounce | status_change.
 * When a matching event lands, the enrollment is stopped and no further
 * steps send. The cron endpoint calls processDueEnrollments() to deliver
 * whatever is due.
 */

export async function enrollContact(sequenceId: string, contactId: string) {
  const supabase = createAdminClient();
  const { data: firstStep, error: stepError } = await supabase
    .from('sequence_steps')
    .select('delay_days')
    .eq('sequence_id', sequenceId)
    .order('step_order')
    .limit(1)
    .maybeSingle();
  if (stepError) throw new Error(stepError.message);

  const delayMs = (firstStep?.delay_days ?? 0) * 24 * 60 * 60 * 1000;
  const { error: enrollmentError } = await supabase.from('sequence_enrollments').upsert(
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
  if (enrollmentError) throw new Error(enrollmentError.message);
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
  const { data: enrollments, error: enrollmentReadError } = await supabase
    .from('sequence_enrollments')
    .select('id, sequence_id, email_sequences ( stop_on, stop_status_ids )')
    .eq('contact_id', contactId)
    .eq('status', 'active');
  if (enrollmentReadError) throw new Error(enrollmentReadError.message);

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
    const { error } = await supabase
      .from('sequence_enrollments')
      .update({ status: 'stopped', stop_reason: event })
      .eq('id', e.id);
    if (error) throw new Error(error.message);
  }
}

/** Starts any active status_change sequences that target the new status. */
export async function startSequencesForStatus(contactId: string, newStatusId: string) {
  const supabase = createAdminClient();
  const { data: sequences, error } = await supabase
    .from('email_sequences')
    .select('id, start_status_ids')
    .eq('active', true)
    .eq('start_trigger', 'status_change');
  if (error) throw new Error(error.message);

  for (const seq of sequences ?? []) {
    if ((seq.start_status_ids ?? []).includes(newStatusId)) {
      await enrollContact(seq.id, contactId);
    }
  }
}

/** Called by the cron endpoint: sends every step that has come due. */
export async function processDueEnrollments(limit = 2): Promise<{ sent: number; errors: number }> {
  const supabase = createAdminClient();
  let sent = 0;
  let errors = 0;

  const { data: due, error: claimError } = await supabase.rpc(
    'claim_due_sequence_enrollments',
    { p_limit: Math.min(Math.max(limit, 1), 5) }
  );
  if (claimError) throw claimError;

  for (const enrollment of (due ?? []) as any[]) {
    try {
      const [sequenceResult, stepsResult, contactResult] = await Promise.all([
        supabase.from('email_sequences').select('*').eq('id', enrollment.sequence_id).single(),
        supabase
          .from('sequence_steps')
          .select('*, email_templates ( subject, html )')
          .eq('sequence_id', enrollment.sequence_id)
          .order('step_order'),
        supabase.from('contacts').select('*').eq('id', enrollment.contact_id).single(),
      ]);
      if (sequenceResult.error) throw new Error(sequenceResult.error.message);
      if (stepsResult.error) throw new Error(stepsResult.error.message);
      if (contactResult.error) throw new Error(contactResult.error.message);
      const sequence = sequenceResult.data;
      const steps = stepsResult.data;
      const contact = contactResult.data;

      if (!sequence?.active || !contact?.email) {
        const { error } = await supabase
          .from('sequence_enrollments')
          .update({ status: 'stopped', stop_reason: !sequence?.active ? 'sequence_inactive' : 'no_email' })
          .eq('id', enrollment.id);
        if (error) throw new Error(error.message);
        continue;
      }

      const nextStep = (steps ?? [])[enrollment.current_step];
      if (!nextStep) {
        const { error } = await supabase
          .from('sequence_enrollments')
          .update({ status: 'completed', next_send_at: null })
          .eq('id', enrollment.id);
        if (error) throw new Error(error.message);
        continue;
      }

      // A step carries its own inline body (new model); steps created before
      // that fall back to their linked template.
      const step = nextStep as any;
      const template = step.email_templates;
      const rawSubject = step.html ? (step.subject ?? '') : (template?.subject ?? '');
      const rawHtml = step.html ? step.html : (template?.html ?? '');
      // Resolve {{link1}}/{{links}} against this contact's removal links when used.
      const rendered = await withLinkPlaceholders(supabase, contact, rawSubject, rawHtml);
      const result = await sendCrmEmail({
        to: contact.email,
        subject: renderTemplate(rawSubject, rendered),
        html: renderTemplate(rawHtml, rendered, { html: true }),
        accountId: sequence.send_account_id,
        contactId: contact.id,
        sequenceId: sequence.id,
        sequenceStepId: nextStep.id,
        deliveryKey: `sequence:${enrollment.id}:step:${nextStep.id}`,
      });

      if (!result.ok) {
        errors += 1;
        const { error } = await supabase
          .from('sequence_enrollments')
          .update(
            sequenceFailureUpdate(
              enrollment.attempt_count ?? 0,
              result.error ?? 'Email delivery failed'
            )
          )
          .eq('id', enrollment.id);
        if (error) throw new Error(error.message);
        continue;
      }
      sent += 1;

      const following = (steps ?? [])[enrollment.current_step + 1];
      const { error: advanceError } = await supabase
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
      if (advanceError) throw new Error(advanceError.message);
    } catch (error: any) {
      errors += 1;
      const { error: failureUpdateError } = await supabase
        .from('sequence_enrollments')
        .update(
          sequenceFailureUpdate(
            enrollment.attempt_count ?? 0,
            error?.message ?? 'Unexpected sequence processing failure'
          )
        )
        .eq('id', enrollment.id);
      if (failureUpdateError) throw new Error(failureUpdateError.message);
    }
  }

  return { sent, errors };
}
