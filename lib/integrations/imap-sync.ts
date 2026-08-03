import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createAdminClient } from '@/lib/supabase/server';
import { enqueueJob } from '@/lib/job-queue';
import { logDebug } from '@/lib/debug-log';

const FOLDER = 'INBOX';
const INITIAL_BACKFILL = 200; // most-recent N messages imported on the first sync
const MAX_PER_RUN = 100; // bounded so one job stays short; the next run continues
const SYNC_BUCKET_MS = 3 * 60_000; // at most one queued sync per account per 3 min
const RECONCILE_WINDOW = 200; // reflect server \Seen / deletions over this recent UID window

type WritebackOp = 'seen' | 'unseen' | 'delete';

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// 465-style implicit TLS is 993 for IMAP; 143 is plaintext + STARTTLS (imapflow
// upgrades it automatically). Mirrors the SMTP/port logic so a mismatch can't
// cause the "wrong version number" class of failure.
function imapSecure(port: number, stored: boolean | null | undefined): boolean {
  return stored === null || stored === undefined ? port !== 143 : stored;
}

type AdminClient = ReturnType<typeof createAdminClient>;

/** Pull new INBOX mail for one account into email_messages (inbound). */
export async function runImapSync(accountId: string, signal?: AbortSignal): Promise<void> {
  const admin = createAdminClient();
  const { data: account } = await admin
    .from('email_accounts')
    .select(
      'id, from_email, imap_host, imap_port, imap_username, imap_password, imap_secure, imap_enabled, imap_allow_invalid_cert'
    )
    .eq('id', accountId)
    .maybeSingle();
  if (!account?.imap_enabled || !account.imap_host || !account.imap_password) return;

  const port = Number(account.imap_port ?? 993);
  const client = new ImapFlow({
    host: String(account.imap_host),
    port,
    secure: imapSecure(port, account.imap_secure),
    auth: { user: String(account.imap_username), pass: String(account.imap_password) },
    logger: false,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    ...(account.imap_allow_invalid_cert ? { tls: { rejectUnauthorized: false } } : {}),
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock(FOLDER);
    try {
      const box = client.mailbox; // false if none open; a MailboxObject while locked
      if (!box) return;
      const uidValidity = Number(box.uidValidity);
      const uidNext = Number(box.uidNext ?? 1);

      const { data: state } = await admin
        .from('imap_folder_state')
        .select('uidvalidity, last_uid')
        .eq('account_id', accountId)
        .eq('folder', FOLDER)
        .maybeSingle();

      // First sync, or the mailbox was recreated (uidvalidity changed): import
      // only the most recent window rather than the entire history.
      let lastUid = state && Number(state.uidvalidity) === uidValidity ? Number(state.last_uid) : 0;
      if (lastUid === 0) lastUid = Math.max(0, uidNext - INITIAL_BACKFILL - 1);

      let maxUid = lastUid;
      let processed = 0;
      for await (const msg of client.fetch(
        `${lastUid + 1}:*`,
        { uid: true, source: true, flags: true },
        { uid: true }
      )) {
        if (signal?.aborted) break;
        const uid = Number(msg.uid);
        if (uid <= lastUid) continue; // `X:*` re-lists the highest UID when X > highest
        const seen = msg.flags instanceof Set ? msg.flags.has('\\Seen') : false;
        if (msg.source) await storeMessage(admin, account, uid, uidValidity, msg.source, seen);
        if (uid > maxUid) maxUid = uid;
        if (++processed >= MAX_PER_RUN) break;
      }

      // Reflect server-side changes (Thunderbird / mobile) back into the CRM over a
      // bounded recent window: \Seen changes, and messages deleted/moved away.
      if (maxUid > 0) {
        await reconcileRecent(client, admin, accountId, uidValidity, Math.max(1, maxUid - RECONCILE_WINDOW));
      }

      await admin.from('imap_folder_state').upsert(
        {
          account_id: accountId,
          folder: FOLDER,
          uidvalidity: uidValidity,
          last_uid: maxUid,
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: 'account_id,folder' }
      );
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

async function storeMessage(
  admin: AdminClient,
  account: { id: string; from_email: string | null },
  uid: number,
  uidValidity: number,
  source: Buffer,
  seen: boolean
): Promise<void> {
  const parsed = await simpleParser(source);
  const fromEmail = parsed.from?.value?.[0]?.address ?? '';
  const toField = parsed.to;
  const toEmail =
    (Array.isArray(toField) ? toField.map((t) => t.text).join(', ') : toField?.text) ??
    account.from_email ??
    '';
  const html =
    parsed.html ||
    (parsed.text
      ? `<pre style="white-space:pre-wrap;font:inherit;margin:0">${escapeHtml(parsed.text)}</pre>`
      : '');
  const receivedAt = (parsed.date ?? new Date()).toISOString();

  let contactId: string | null = null;
  if (fromEmail) {
    const { data: c } = await admin
      .from('contacts')
      .select('id')
      .ilike('email', fromEmail)
      .limit(1)
      .maybeSingle();
    contactId = c?.id ?? null;
  }

  const { error } = await admin.from('email_messages').insert({
    contact_id: contactId,
    account_id: account.id,
    direction: 'inbound',
    from_email: (fromEmail || '(unknown sender)').slice(0, 320),
    to_email: String(toEmail).slice(0, 320),
    subject: (parsed.subject ?? '').slice(0, 500),
    html,
    message_id: parsed.messageId ?? null,
    in_reply_to: parsed.inReplyTo ?? null,
    status: 'received',
    seen,
    imap_uid: uid,
    imap_folder: FOLDER,
    imap_uidvalidity: uidValidity,
    created_at: receivedAt,
  });
  // 23505 = this UID is already stored (a re-run overlap); anything else is odd.
  if (error && error.code !== '23505') {
    await logDebug({
      level: 'warn',
      source: 'imap-sync',
      message: `Could not store IMAP message uid ${uid} for account ${account.id}: ${error.message}`,
    }).catch(() => {});
  }
}

/**
 * Reflect the server's current state back into the CRM over a bounded recent UID
 * window: update the read flag, and hide messages that were deleted/moved away in
 * another client (Thunderbird / mobile). Bounded, so it stays cheap each run.
 */
async function reconcileRecent(
  client: ImapFlow,
  admin: AdminClient,
  accountId: string,
  uidValidity: number,
  sinceUid: number
): Promise<void> {
  const live = new Map<number, boolean>(); // uid -> seen, for what still exists on the server
  for await (const msg of client.fetch(`${sinceUid}:*`, { uid: true, flags: true }, { uid: true })) {
    live.set(Number(msg.uid), msg.flags instanceof Set ? msg.flags.has('\\Seen') : false);
  }
  const { data: rows } = await admin
    .from('email_messages')
    .select('id, imap_uid, seen')
    .eq('account_id', accountId)
    .eq('imap_folder', FOLDER)
    .eq('imap_uidvalidity', uidValidity)
    .gte('imap_uid', sinceUid)
    .is('hidden_at', null);
  for (const row of rows ?? []) {
    const uid = Number(row.imap_uid);
    if (!live.has(uid)) {
      await admin
        .from('email_messages')
        .update({ hidden_at: new Date().toISOString() })
        .eq('id', row.id);
    } else if (live.get(uid) !== row.seen) {
      await admin.from('email_messages').update({ seen: live.get(uid) }).eq('id', row.id);
    }
  }
}

async function findTrashPath(client: ImapFlow): Promise<string | null> {
  const boxes = await client.list();
  const special = boxes.find((b) => b.specialUse === '\\Trash');
  if (special) return special.path;
  const byName = boxes.find((b) => /(^|[./])trash$/i.test(b.path));
  return byName?.path ?? null;
}

/** Apply one CRM action to the mailbox so other clients see it. */
export async function runImapWriteback(
  op: WritebackOp,
  messageId: string,
  signal?: AbortSignal
): Promise<void> {
  const admin = createAdminClient();
  const { data: msg } = await admin
    .from('email_messages')
    .select('id, account_id, imap_uid, imap_folder')
    .eq('id', messageId)
    .maybeSingle();
  if (!msg?.account_id || msg.imap_uid == null || !msg.imap_folder) return; // not a synced IMAP message

  const { data: account } = await admin
    .from('email_accounts')
    .select('imap_host, imap_port, imap_username, imap_password, imap_secure, imap_enabled, imap_allow_invalid_cert')
    .eq('id', msg.account_id)
    .maybeSingle();
  if (!account?.imap_enabled || !account.imap_host || !account.imap_password) return;

  const port = Number(account.imap_port ?? 993);
  const client = new ImapFlow({
    host: String(account.imap_host),
    port,
    secure: imapSecure(port, account.imap_secure),
    auth: { user: String(account.imap_username), pass: String(account.imap_password) },
    logger: false,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    ...(account.imap_allow_invalid_cert ? { tls: { rejectUnauthorized: false } } : {}),
  });

  await client.connect();
  try {
    if (signal?.aborted) return;
    const lock = await client.getMailboxLock(msg.imap_folder);
    try {
      const range = String(msg.imap_uid);
      if (op === 'seen') {
        await client.messageFlagsAdd(range, ['\\Seen'], { uid: true });
      } else if (op === 'unseen') {
        await client.messageFlagsRemove(range, ['\\Seen'], { uid: true });
      } else {
        const trash = await findTrashPath(client);
        if (trash) await client.messageMove(range, trash, { uid: true });
        else await client.messageDelete(range, { uid: true }); // no Trash folder: expunge
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/** Queue a write-back op for one message (deduped per op + message). */
export async function enqueueImapWriteback(op: WritebackOp, messageId: string): Promise<void> {
  await enqueueJob('imap_writeback', { op, messageId }, `imap-wb:${op}:${messageId}`, 3);
}

/** Queue a sync for each receiving account — at most one per account per bucket. */
export async function enqueueDueImapSyncs(): Promise<{ enqueued: number }> {
  const admin = createAdminClient();
  const { data: accounts } = await admin.from('email_accounts').select('id').eq('imap_enabled', true);
  if (!accounts?.length) return { enqueued: 0 };
  const bucket = Math.floor(Date.now() / SYNC_BUCKET_MS);
  let enqueued = 0;
  for (const a of accounts) {
    await enqueueJob('imap_sync', { accountId: a.id }, `imap-sync:${a.id}:${bucket}`, 3);
    enqueued += 1;
  }
  return { enqueued };
}

/**
 * Manual "sync now": queue a fresh pull for each receiving account on a short
 * (20s) bucket, so rapid refresh clicks dedupe but a refresh still forces a new
 * pull — unlike the 3-minute periodic bucket above.
 */
export async function enqueueImapSyncNow(): Promise<{ enqueued: number }> {
  const admin = createAdminClient();
  const { data: accounts } = await admin.from('email_accounts').select('id').eq('imap_enabled', true);
  if (!accounts?.length) return { enqueued: 0 };
  const bucket = Math.floor(Date.now() / 20_000);
  let enqueued = 0;
  for (const a of accounts) {
    await enqueueJob('imap_sync', { accountId: a.id }, `imap-sync:${a.id}:manual:${bucket}`, 3);
    enqueued += 1;
  }
  return { enqueued };
}
