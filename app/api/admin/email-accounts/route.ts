import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import { logDebug } from '@/lib/debug-log';

function accountValues(body: any, requirePassword: boolean) {
  const password = typeof body.smtp_password === 'string' ? body.smtp_password : '';
  const port = Number(body.smtp_port ?? 587);
  if (!body.name || !body.from_email || !body.smtp_host || !body.smtp_username) {
    throw new Error('Name, from email, SMTP host and username are required');
  }
  if (requirePassword && !password) throw new Error('SMTP password is required');
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
  if (password) values.smtp_password = password.slice(0, 4096);

  const imapPort = Number(body.imap_port ?? 993);
  if (!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65_535) {
    throw new Error('IMAP port must be between 1 and 65535');
  }
  const imapEnabled = body.imap_enabled === true;
  const imapHost = body.imap_host ? String(body.imap_host).trim().slice(0, 253) : null;
  const imapUsername = body.imap_username ? String(body.imap_username).trim().slice(0, 320) : null;
  const imapPassword = typeof body.imap_password === 'string' ? body.imap_password : '';
  if (imapEnabled && (!imapHost || !imapUsername)) {
    throw new Error('IMAP host and username are required to enable receiving');
  }
  if (requirePassword && imapEnabled && !imapPassword) {
    throw new Error('IMAP password is required to enable receiving');
  }
  values.imap_host = imapHost;
  values.imap_port = imapPort;
  values.imap_username = imapUsername;
  values.imap_secure = body.imap_secure === undefined ? imapPort !== 143 : body.imap_secure === true;
  values.imap_enabled = imapEnabled;
  if (imapPassword) values.imap_password = imapPassword.slice(0, 4096);
  return values;
}

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  try {
    const body = await readJsonBody(request, 128 * 1024);
    const { data, error } = await createAdminClient()
      .from('email_accounts')
      .insert(accountValues(body, true))
      .select('id')
      .single();
    if (error) throw error;
    await logDebug({
      level: 'info',
      source: 'admin:email-accounts',
      message: `SMTP account created by ${auth.profile.email}`,
      context: { account_id: data.id, actor_id: auth.profile.id },
    });
    return NextResponse.json({ id: data.id }, { status: 201 });
  } catch (error) {
    return apiFailure('api:admin/email-accounts', error);
  }
}
