import { NextResponse } from 'next/server';
import { ImapFlow } from 'imapflow';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import { logDebug } from '@/lib/debug-log';
import { resolvePublicMailTarget, validateImapTarget } from '@/lib/imap-target';

// nodemailer/imapflow use Node sockets — never the edge runtime.
export const runtime = 'nodejs';

// Guards against a blocked port hanging the request past imapflow's own timeouts.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`${label} timed out after ${Math.round(ms / 1000)}s — host/port unreachable or blocked`)
          ),
        ms
      )
    ),
  ]);
}

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
    let allowInvalidCert = body.imap_allow_invalid_cert === true;

    // Testing with the stored password (blank password + accountId): reuse the
    // COMPLETE stored connection tuple and ignore any request-supplied host /
    // username / port / TLS. Otherwise the stored password could be authenticated
    // against an attacker-chosen host (finding #5).
    if (body.accountId && !password) {
      const { data, error } = await createAdminClient()
        .from('email_accounts')
        .select('imap_host, imap_port, imap_username, imap_password, imap_secure, imap_allow_invalid_cert')
        .eq('id', String(body.accountId))
        .maybeSingle();
      if (error) throw error;
      if (!data?.imap_password) {
        return NextResponse.json(
          { ok: false, error: 'No stored IMAP password for this account — enter the password to test.' },
          { status: 400 }
        );
      }
      host = data.imap_host ?? '';
      port = Number(data.imap_port ?? 993) || 993;
      username = data.imap_username ?? '';
      password = data.imap_password;
      secure = data.imap_secure;
      allowInvalidCert = data.imap_allow_invalid_cert === true;
    }

    if (!host || !username || !password) {
      return NextResponse.json(
        { ok: false, error: 'IMAP host, username and password are required to test.' },
        { status: 400 }
      );
    }

    const targetError = validateImapTarget(host, port);
    if (targetError) {
      return NextResponse.json({ ok: false, error: targetError }, { status: 400 });
    }
    const target = await resolvePublicMailTarget(host, port, 'imap');

    // TLS follows the port (mirrors the SMTP fix): 993 = implicit TLS on connect,
    // 143 = STARTTLS (imapflow upgrades a plaintext 143 connection automatically).
    const useSecure = secure === undefined ? port !== 143 : !!secure;
    const client = new ImapFlow({
      host: target.address,
      port,
      secure: useSecure,
      auth: { user: username, pass: password },
      logger: false,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,
      // Opt-in: accept a mismatched/self-signed cert for this one mailbox (the
      // exception a desktop client makes you approve on shared hosts like WPX).
      tls: {
        ...(target.servername ? { servername: target.servername } : {}),
        rejectUnauthorized: !allowInvalidCert,
      },
    });

    try {
      await withTimeout(client.connect(), 20_000, 'IMAP connect');
      const boxes = await client.list();
      const folders = boxes.map((b: { path: string }) => b.path).slice(0, 200);
      await client.logout();
      return NextResponse.json({ ok: true, folders });
    } catch (imapError: any) {
      try {
        client.close();
      } catch {
        /* already down */
      }
      // Surface the server's actual reason. imapflow's bare `.message` is often
      // just "Command failed"; the useful text lives in .responseText / .response,
      // and auth failures set .authenticationFailed. TLS/cert problems (common on
      // shared hosts whose mail cert is for the server hostname) show up here too.
      const reason =
        imapError?.responseText || imapError?.response || imapError?.message || 'connection failed';
      const detail = imapError?.authenticationFailed
        ? `authentication failed — check the username (often the full email address) and password (${reason})`
        : String(reason);
      await logDebug({
        level: 'warn',
        source: 'email-accounts:test-imap',
        message: `IMAP test failed for ${host}:${port} — ${detail}`,
      }).catch(() => {});
      // A bad host/credential is an expected test outcome, not a 500.
      return NextResponse.json({ ok: false, error: detail.slice(0, 500) }, { status: 200 });
    }
  } catch (error) {
    return apiFailure('api:admin/email-accounts/test-imap', error);
  }
}
