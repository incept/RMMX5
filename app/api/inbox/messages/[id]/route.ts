import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { enqueueImapWriteback } from '@/lib/integrations/imap-sync';
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
    const { data: msg } = await admin
      .from('email_messages')
      .update({ seen })
      .eq('id', id)
      .select('id, imap_uid, direction')
      .maybeSingle();
    if (!msg) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (msg.imap_uid != null && msg.direction === 'inbound') {
      await enqueueImapWriteback(seen ? 'seen' : 'unseen', id);
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
      .update({ hidden_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, imap_uid, direction')
      .maybeSingle();
    if (!msg) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (msg.imap_uid != null && msg.direction === 'inbound') {
      await enqueueImapWriteback('delete', id);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiFailure('api:inbox/messages', error);
  }
}
