import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { enqueueImapReconcile } from '@/lib/integrations/imap-sync';
import { apiFailure } from '@/lib/api-errors';

type Params = { params: Promise<{ id: string }> };

/**
 * Mark a message read/unread (PATCH { seen }). For a synced inbound message this
 * also flags \Seen on the mailbox, so Thunderbird / mobile reflect it.
 */
export async function PATCH(request: Request, { params }: Params) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const { id } = await params;
  try {
    const body = await request.json().catch(() => ({}));
    const seen = body?.seen !== false; // default: mark read
    const admin = createAdminClient();
    // Set the write-back dirty flag in the SAME update as `seen`, so there is
    // never a state change with no pending mailbox op even if the enqueue below
    // fails — the periodic sync's reconcile still converges it (finding #4).
    const { data: msg } = await admin
      .from('email_messages')
      .update({ seen, imap_wb_dirty: true })
      .eq('id', id)
      .select('id, imap_uid, direction, account_id')
      .maybeSingle();
    if (!msg) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (msg.imap_uid != null && msg.direction === 'inbound' && msg.account_id) {
      await enqueueImapReconcile(msg.account_id);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiFailure('api:inbox/messages', error);
  }
}

/**
 * Delete a message: hide it from the CRM inbox and, for a synced inbound message,
 * move it to Trash on the mailbox (recoverable). The row is kept (soft-delete) so
 * a later sync never re-imports it.
 */
export async function DELETE(_request: Request, { params }: Params) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const { id } = await params;
  try {
    const admin = createAdminClient();
    const { data: msg } = await admin
      .from('email_messages')
      .update({ hidden_at: new Date().toISOString(), imap_wb_dirty: true })
      .eq('id', id)
      .select('id, imap_uid, direction, account_id')
      .maybeSingle();
    if (!msg) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (msg.imap_uid != null && msg.direction === 'inbound' && msg.account_id) {
      await enqueueImapReconcile(msg.account_id);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiFailure('api:inbox/messages', error);
  }
}
