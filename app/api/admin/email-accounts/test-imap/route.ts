import { NextResponse } from 'next/server';
import { ImapFlow } from 'imapflow';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';

// nodemailer/imapflow use Node sockets — never the edge runtime.
export const runtime = 'nodejs';

/**
 * Validate a set of IMAP credentials before we build sync on top of them:
 * connect, list the mailboxes, disconnect. Admin-only. Editing an existing
 * account can leave the password blank to reuse the stored one (it is never
 * sent back to the browser).
 */
export async function POST(request: Request) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  try {
    const body = (await readJsonBody(request, 16 * 1024)) as Record<string, any>;
    let host = body.imap_host ? String(body.imap_host).trim() : '';
    let port = Number(body.imap_port ?? 993) || 993;
    let username = body.imap_username ? String(body.imap_username).trim() : '';
    let password = typeof body.imap_password === 'string' ? body.imap_password : '';
    let secure = body.imap_secure;

    // Editing without retyping the password: pull the stored one (and any
    // unspecified fields) from the account.
    if (body.accountId && !password) {
      const { data } = await createAdminClient()
        .from('email_accounts')
        .select('imap_host, imap_port, imap_username, imap_password, imap_secure')
        .eq('id', String(body.accountId))
        .maybeSingle();
      if (data) {
        host = host || (data.imap_host ?? '');
        port = port || (data.imap_port ?? 993);
        username = username || (data.imap_username ?? '');
        password = data.imap_password ?? '';
        if (secure === undefined) secure = data.imap_secure;
      }
    }

    if (!host || !username || !password) {
      return NextResponse.json(
        { ok: false, error: 'IMAP host, username and password are required to test.' },
        { status: 400 }
      );
    }

    // TLS follows the port (mirrors the SMTP fix): 993 = implicit TLS on connect,
    // 143 = STARTTLS (imapflow upgrades a plaintext 143 connection automatically).
    const useSecure = secure === undefined ? port !== 143 : !!secure;
    const client = new ImapFlow({
      host,
      port,
      secure: useSecure,
      auth: { user: username, pass: password },
      logger: false,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,
    });

    try {
      await client.connect();
      const boxes = await client.list();
      const folders = boxes.map((b) => b.path).slice(0, 200);
      await client.logout();
      return NextResponse.json({ ok: true, folders });
    } catch (imapError: any) {
      try {
        client.close();
      } catch {
        /* already down */
      }
      // A bad password / host is an expected outcome of a test, not a 500.
      return NextResponse.json(
        { ok: false, error: imapError?.message ?? 'IMAP connection failed' },
        { status: 200 }
      );
    }
  } catch (error) {
    return apiFailure('api:admin/email-accounts/test-imap', error);
  }
}
