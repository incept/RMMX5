import { createAdminClient } from '@/lib/supabase/server';
import { stopEnrollmentsFor } from '@/lib/sequence-runner';
import { logActivity } from '@/lib/activity';

/**
 * Records one inbound email into the unified inbox and runs the reply side
 * effects: match the sender to a contact by normalised email, mark that
 * contact's most recent outbound message as replied, stop any sequences with a
 * "reply" stop trigger, and log the activity.
 *
 * Shared by the generic inbound webhook (any forwarder that POSTs a full body)
 * and the Emailit `email.received` handler (which fetches the body by id first),
 * so both paths land identical rows and side effects.
 */
export async function recordInboundEmail(input: {
  from: string;
  to?: string | null;
  subject?: string | null;
  html?: string | null;
  text?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
}): Promise<{ contactId: string | null; messageRowId: string | null }> {
  const admin = createAdminClient();
  const extracted = String(input.from).match(/[^\s<>"]+@[^\s<>"]+/)?.[0] ?? String(input.from);
  const fromEmail = extracted.trim().toLowerCase().slice(0, 320);
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail);

  const { data: contact } = validEmail
    ? await admin
        .from('contacts')
        .select('id, name')
        .eq('email_normalized', fromEmail)
        .limit(1)
        .maybeSingle()
    : { data: null };

  const { data: message, error: messageError } = await admin
    .from('email_messages')
    .insert({
      contact_id: contact?.id ?? null,
      direction: 'inbound',
      from_email: fromEmail,
      to_email: String(input.to ?? '').slice(0, 320),
      subject: String(input.subject ?? '(no subject)').slice(0, 500),
      html: String(input.html ?? input.text ?? '').slice(0, 750_000),
      message_id: input.messageId ? String(input.messageId).slice(0, 1000) : null,
      in_reply_to: input.inReplyTo ? String(input.inReplyTo).slice(0, 1000) : null,
      status: 'received',
      sent_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (messageError) throw messageError;

  if (contact) {
    // Mark the latest outbound message to this contact as replied.
    const { data: lastOut } = await admin
      .from('email_messages')
      .select('id')
      .eq('contact_id', contact.id)
      .eq('direction', 'outbound')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastOut) {
      await admin.from('email_messages').update({ replied: true }).eq('id', lastOut.id);
      await admin.from('email_events').insert({
        message_id: lastOut.id,
        contact_id: contact.id,
        type: 'reply',
      });
    }
    await stopEnrollmentsFor(contact.id, 'reply');
    await logActivity({
      contactId: contact.id,
      type: 'email',
      description: `Reply received from ${fromEmail}: "${input.subject ?? ''}"`,
      meta: { message_row_id: message?.id },
    });
  }

  return { contactId: contact?.id ?? null, messageRowId: message?.id ?? null };
}
