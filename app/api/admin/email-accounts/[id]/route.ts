import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import { logDebug } from '@/lib/debug-log';

type Params = { params: Promise<{ id: string }> };

function accountValues(body: any) {
  const port = Number(body.smtp_port ?? 587);
  if (!body.name || !body.from_email || !body.smtp_host || !body.smtp_username) {
    throw new Error('Name, from email, SMTP host and username are required');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SMTP port must be between 1 and 65535');
  }
  const values: Record<string, unknown> = {
    name: String(body.name).trim().slice(0, 200),
    from_name: String(body.from_name ?? '').trim().slice(0, 200),
    from_email: String(body.from_email).trim().slice(0, 320),
    smtp_host: String(body.smtp_host).trim().slice(0, 253),
    smtp_port: port,
    smtp_username: String(body.smtp_username).trim().slice(0, 320),
    smtp_secure: body.smtp_secure === true,
    signature_html: String(body.signature_html ?? '').slice(0, 100_000),
    is_default: body.is_default === true,
  };
  if (typeof body.smtp_password === 'string' && body.smtp_password) {
    values.smtp_password = body.smtp_password.slice(0, 4096);
  }

  const imapPort = Number(body.imap_port ?? 993);
  if (!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65_535) {
    throw new Error('IMAP port must be between 1 and 65535');
  }
  const imapEnabled = body.imap_enabled === true;
  const imapHost = body.imap_host ? String(body.imap_host).trim().slice(0, 253) : null;
  const imapUsername = body.imap_username ? String(body.imap_username).trim().slice(0, 320) : null;
  if (imapEnabled && (!imapHost || !imapUsername)) {
    throw new Error('IMAP host and username are required to enable receiving');
  }
  values.imap_host = imapHost;
  values.imap_port = imapPort;
  values.imap_username = imapUsername;
  values.imap_secure = body.imap_secure === undefined ? imapPort !== 143 : body.imap_secure === true;
  values.imap_enabled = imapEnabled;
  values.imap_allow_invalid_cert = body.imap_allow_invalid_cert === true;
  if (typeof body.imap_password === 'string' && body.imap_password) {
    values.imap_password = body.imap_password.slice(0, 4096);
  }
  return values;
}

export async function PATCH(request: Request, { params }: Params) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const { id } = await params;
  try {
    const body = await readJsonBody(request, 128 * 1024);
    const { data, error } = await createAdminClient()
      .from('email_accounts')
      .update(accountValues(body))
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    await logDebug({
      level: 'info',
      source: 'admin:email-accounts',
      message: `SMTP account updated by ${auth.profile.email}`,
      context: { account_id: id, actor_id: auth.profile.id },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiFailure('api:admin/email-accounts', error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const { id } = await params;
  const { error } = await createAdminClient().from('email_accounts').delete().eq('id', id);
  if (error) return apiFailure('api:admin/email-accounts', error);
  await logDebug({
    level: 'info',
    source: 'admin:email-accounts',
    message: `SMTP account deleted by ${auth.profile.email}`,
    context: { account_id: id, actor_id: auth.profile.id },
  }).catch(() => {});
  return NextResponse.json({ ok: true });
}
