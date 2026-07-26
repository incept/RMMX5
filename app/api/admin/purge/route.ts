import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import { logDebug } from '@/lib/debug-log';

const TARGETS = new Set([
  'email_events',
  'email_messages',
  'calls',
  'activity_log',
  'notifications_log',
  'imports',
  'search_candidates',
  'debug_log',
  'webhook_leads',
  'sms_messages',
  'voicemail_sends',
  'job_queue',
  'usage_events',
  'contact_files',
]);

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;

  let body: any;
  try {
    body = await readJsonBody(request, 16 * 1024);
  } catch (error) {
    return apiFailure('api:admin/purge', error);
  }
  const target = String(body.target ?? '');
  const days = Number(body.olderThanDays);
  if (!TARGETS.has(target) || !Number.isInteger(days) || days < 1 || days > 3650) {
    return NextResponse.json({ error: 'Invalid purge target or interval' }, { status: 400 });
  }
  if (body.confirm !== `PURGE ${target}`) {
    return NextResponse.json({ error: `Confirmation must equal PURGE ${target}` }, { status: 400 });
  }

  const admin = createAdminClient();
  try {
    let deleted = 0;
    let remaining = false;
    if (target === 'contact_files') {
      // Storage APIs are outside Postgres transactions. Work in a small batch,
      // remove objects first, and only then remove their metadata.
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const { data: files, error: listError } = await admin
        .from('contact_files')
        .select('id, storage_path')
        .lt('created_at', cutoff)
        .order('created_at')
        .limit(200);
      if (listError) throw listError;
      if (files?.length) {
        const { error: storageError } = await admin.storage
          .from('contact-files')
          .remove(files.map((file) => file.storage_path));
        if (storageError) throw storageError;
        const { error: deleteError, count } = await admin
          .from('contact_files')
          .delete({ count: 'exact' })
          .in('id', files.map((file) => file.id));
        if (deleteError) throw deleteError;
        deleted = count ?? files.length;
        remaining = files.length === 200;
      }
    } else {
      const { data, error } = await admin.rpc('purge_admin_data', {
        p_target: target,
        p_older_than_days: days,
      });
      if (error) throw error;
      deleted = Number(data ?? 0);
    }

    await logDebug({
      level: 'info',
      source: 'admin:purge',
      message: `${auth.profile.email} purged ${deleted} ${target} row(s) older than ${days} days`,
      context: { target, days, deleted, remaining, actor_id: auth.profile.id },
    });
    return NextResponse.json({ ok: true, target, deleted, remaining });
  } catch (error) {
    return apiFailure('api:admin/purge', error, {
      context: { target, days, actor_id: auth.profile.id },
    });
  }
}
