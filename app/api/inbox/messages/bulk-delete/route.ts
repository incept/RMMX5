import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { enqueueImapWriteback } from '@/lib/integrations/imap-sync';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';

export const runtime = 'nodejs';

/**
 * Soft-delete many messages at once, and move each synced inbound one to Trash on
 * the mailbox. Static segment `bulk-delete` wins over the sibling `[id]` route.
 */
export async function POST(request: Request) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  try {
    const body = (await readJsonBody(request, 64 * 1024)) as { ids?: unknown };
    const ids = Array.isArray(body?.ids)
      ? [...new Set(body.ids.filter((x): x is string => typeof x === 'string'))].slice(0, 500)
      : [];
    if (!ids.length) return NextResponse.json({ error: 'No message ids' }, { status: 400 });

    const admin = createAdminClient();
    const { data: rows, error } = await admin
      .from('email_messages')
      .update({ hidden_at: new Date().toISOString() })
      .in('id', ids)
      .is('hidden_at', null)
      .select('id, imap_uid, direction');
    if (error) throw error;

    for (const r of rows ?? []) {
      if (r.imap_uid != null && r.direction === 'inbound') await enqueueImapWriteback('delete', r.id);
    }
    return NextResponse.json({ ok: true, deleted: rows?.length ?? 0 });
  } catch (error) {
    return apiFailure('api:inbox/messages/bulk-delete', error);
  }
}
