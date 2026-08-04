import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import { logDebug } from '@/lib/debug-log';
import { sanitizeEmailHtml } from '@/lib/html-sanitize';
import {
  resolvePublicMailTarget,
  validateImapTarget,
  validateSmtpTarget,
} from '@/lib/imap-target';

type Params = { params: Promise<{ id: string }> };

type ExistingImap = {
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_username: string | null;
  imap_host: string | null;
  imap_port: number | null;
  imap_username: string | null;
} | null;

async function accountValues(body: any, existing?: ExistingImap) {
  const port = Number(body.smtp_port ?? 587);
  if (!body.name || !body.from_email || !body.smtp_host || !body.smtp_username) {
    throw new Error('Name, from email, SMTP host and username are required');
  }
  const smtpHost = String(body.smtp_host ?? '').trim().slice(0, 253);
  const smtpUsername = String(body.smtp_username ?? '').trim().slice(0, 320);
  const smtpTargetError = validateSmtpTarget(smtpHost, port);
  if (smtpTargetError) throw new Error(smtpTargetError);
  await resolvePublicMailTarget(smtpHost, port, 'smtp');
  const newSmtpPassword =
    typeof body.smtp_password === 'string' && body.smtp_password
      ? body.smtp_password.slice(0, 4096)
      : null;
  const smtpIdentityChanged =
    !existing ||
    (existing.smtp_host ?? null) !== smtpHost ||
    Number(existing.smtp_port ?? 587) !== port ||
    (existing.smtp_username ?? null) !== smtpUsername;
  if (smtpIdentityChanged && !newSmtpPassword) {
    throw new Error('Re-enter the SMTP password to change the mail host, port, or username.');
  }
  const values: Record<string, unknown> = {
    name: String(body.name).trim().slice(0, 200),
    from_name: String(body.from_name ?? '').trim().slice(0, 200),
    from_email: String(body.from_email).trim().slice(0, 320),
    smtp_host: smtpHost,
    smtp_port: port,
    smtp_username: smtpUsername,
    smtp_secure: body.smtp_secure === true,
    signature_html: sanitizeEmailHtml(String(body.signature_html ?? '').slice(0, 100_000)),
    is_default: body.is_default === true,
  };
  if (newSmtpPassword) values.smtp_password = newSmtpPassword;

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
  const newImapPassword =
    typeof body.imap_password === 'string' && body.imap_password
      ? body.imap_password.slice(0, 4096)
      : null;

  if (imapEnabled) {
    const targetError = validateImapTarget(imapHost!, imapPort);
    if (targetError) throw new Error(targetError);
    await resolvePublicMailTarget(imapHost!, imapPort, 'imap');
    // Require re-entering the password whenever the connection identity changes,
    // so a stored password is never silently re-pointed at a new host / user
    // (finding #5). A first-time setup (no stored host) also requires it.
    const identityChanged =
      !existing ||
      (existing.imap_host ?? null) !== imapHost ||
      Number(existing.imap_port ?? 993) !== imapPort ||
      (existing.imap_username ?? null) !== imapUsername;
    if (identityChanged && !newImapPassword) {
      throw new Error(
        'Re-enter the IMAP password to change the mailbox host, port, or username.'
      );
    }
  }

  values.imap_host = imapHost;
  values.imap_port = imapPort;
  values.imap_username = imapUsername;
  values.imap_secure = body.imap_secure === undefined ? imapPort !== 143 : body.imap_secure === true;
  values.imap_enabled = imapEnabled;
  values.imap_allow_invalid_cert = body.imap_allow_invalid_cert === true;
  if (newImapPassword) {
    values.imap_password = newImapPassword;
  }
  return values;
}

export async function PATCH(request: Request, { params }: Params) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const { id } = await params;
  try {
    const body = await readJsonBody(request, 128 * 1024);
    const admin = createAdminClient();
    // Load the current connection identity so a host/port/username change without
    // a fresh password can be rejected (finding #5).
    const { data: existing, error: existingError } = await admin
      .from('email_accounts')
      .select('smtp_host, smtp_port, smtp_username, imap_host, imap_port, imap_username')
      .eq('id', id)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    const { data, error } = await admin
      .from('email_accounts')
      .update(await accountValues(body, existing))
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
