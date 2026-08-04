import { createAdminClient } from '@/lib/supabase/server';
import { sanitizeEmailHtml } from '@/lib/html-sanitize';

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
  providerMessageId?: string | null;
  inReplyTo?: string | null;
  accountId?: string | null;
  // Present when the message came from an IMAP mailbox pull. Carries the columns
  // that make the row deduplicable + reflectable, and the server's own delivery
  // timestamp (ordering must not trust the sender-controlled Date header).
  imap?: {
    uid: number;
    folder: string;
    uidValidity: number;
    seen: boolean;
    internalDate?: Date | string | null;
  };
}): Promise<{ contactId: string | null; messageRowId: string | null; duplicate?: boolean }> {
  const admin = createAdminClient();
  const extracted = String(input.from).match(/[^\s<>"]+@[^\s<>"]+/)?.[0] ?? String(input.from);
  const fromEmail = extracted.trim().toLowerCase().slice(0, 320);
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail);

  let contact: { id: string; name: string | null } | null = null;
  if (validEmail) {
    const contactResult = await admin
      .from('contacts')
      .select('id, name')
      .eq('email_normalized', fromEmail)
      .limit(1)
      .maybeSingle();
    if (contactResult.error) throw contactResult.error;
    contact = contactResult.data;
  }

  const imap = input.imap;
  const insertRow: Record<string, unknown> = {
    contact_id: contact?.id ?? null,
    account_id: input.accountId ?? null,
    direction: 'inbound',
    from_email: fromEmail,
    to_email: String(input.to ?? '').slice(0, 320),
    subject: String(input.subject ?? '(no subject)').slice(0, 500),
    html: sanitizeEmailHtml(String(input.html ?? input.text ?? '').slice(0, 750_000)),
    message_id: input.messageId ? String(input.messageId).slice(0, 1000) : null,
    provider_message_id: input.providerMessageId
      ? String(input.providerMessageId).slice(0, 256)
      : null,
    in_reply_to: input.inReplyTo ? String(input.inReplyTo).slice(0, 1000) : null,
    status: 'received',
    sent_at: new Date().toISOString(),
  };
  if (imap) {
    insertRow.seen = imap.seen;
    insertRow.imap_uid = imap.uid;
    insertRow.imap_folder = imap.folder;
    insertRow.imap_uidvalidity = imap.uidValidity;
    if (imap.internalDate) insertRow.created_at = new Date(imap.internalDate).toISOString();
  }

  const { data: inserted, error: messageError } = await admin
    .from('email_messages')
    .insert(insertRow)
    .select('id')
    .single();
  let messageId = inserted?.id ?? null;
  let duplicate = false;
  if (messageError) {
    // A retry after the row insert may still need to finish its transactional
    // reply effects. Resolve the exact existing row and call the idempotent
    // finalizer below rather than returning early and losing those effects.
    if (messageError.code === '23505' && (imap || input.providerMessageId)) {
      let existingQuery = admin.from('email_messages').select('id, contact_id');
      if (imap) {
        existingQuery = existingQuery
          .eq('account_id', input.accountId)
          .eq('imap_folder', imap.folder)
          .eq('imap_uidvalidity', imap.uidValidity)
          .eq('imap_uid', imap.uid);
      } else {
        existingQuery = existingQuery.eq('provider_message_id', input.providerMessageId!);
      }
      const existing = await existingQuery.maybeSingle();
      if (existing.error) throw existing.error;
      if (!existing.data) throw messageError;
      messageId = existing.data.id;
      contact = existing.data.contact_id
        ? { id: existing.data.contact_id, name: contact?.name ?? null }
        : null;
      duplicate = true;
    } else {
      // Any other failure propagates so the caller aborts this run and retries
      // from the previous cursor instead of skipping the message.
      throw messageError;
    }
  }

  if (!messageId) throw new Error('Inbound email insert returned no id');
  const finalized = await admin.rpc('finalize_inbound_email_effects', {
    p_message_id: messageId,
  });
  if (finalized.error) throw finalized.error;

  return {
    contactId: contact?.id ?? null,
    messageRowId: messageId,
    ...(duplicate ? { duplicate: true } : {}),
  };
}
