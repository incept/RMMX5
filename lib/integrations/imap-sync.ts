import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { createAdminClient } from '@/lib/supabase/server';
import { enqueueJob } from '@/lib/job-queue';
import { logDebug } from '@/lib/debug-log';
import { recordInboundEmail } from '@/lib/inbound-email';

const FOLDER = 'INBOX';
const INITIAL_BACKFILL = 200; // most-recent N messages imported on the first sync
const MAX_PER_RUN = 100; // bounded so one job stays short; the next run continues
const SYNC_BUCKET_MS = 3 * 60_000; // at most one queued sync per account per 3 min
const RECONCILE_WINDOW = 200; // reflect server \Seen / deletions over this recent UID window
// Only download + parse bodies up to this size. A larger (or hostile) message is
// never buffered/parsed — it lands as a metadata-only row from its envelope, so
// the cursor still advances without a mailbox-driven memory/DB blow-up (#3).
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

// append_sent = copy one outbound message into the Sent folder (per message).
// reconcile   = push the CRM's desired read/deleted state for one account's
//               synced inbound messages back to the mailbox (batched, one conn).
type WritebackOp = 'append_sent' | 'reconcile';

const MAX_WB_PER_RUN = 200; // reconcile at most this many dirty rows per job

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

type ImapConnFields = {
  imap_host: unknown;
  imap_port: unknown;
  imap_username: unknown;
  imap_password: unknown;
  imap_secure: boolean | null;
  imap_allow_invalid_cert: boolean | null;
};

// Build a configured ImapFlow client from an account's stored connection fields.
function newImapClient(account: ImapConnFields): ImapFlow {
  const port = Number(account.imap_port ?? 993);
  return new ImapFlow({
    host: String(account.imap_host),
    port,
    secure: imapSecure(port, account.imap_secure),
    auth: { user: String(account.imap_username), pass: String(account.imap_password) },
    logger: false,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    ...(account.imap_allow_invalid_cert ? { tls: { rejectUnauthorized: false } } : {}),
  });
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

  const client = newImapClient(account);
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

      // Pass 1 — metadata only (no bodies), so an oversized/hostile message is
      // never downloaded in full. We learn each new UID's size, flags, delivery
      // date and envelope cheaply here (finding #3).
      const pending: {
        uid: number;
        size: number;
        seen: boolean;
        internalDate: Date | null;
        envelope: unknown;
      }[] = [];
      for await (const msg of client.fetch(
        `${lastUid + 1}:*`,
        { uid: true, flags: true, size: true, internalDate: true, envelope: true },
        { uid: true }
      )) {
        if (signal?.aborted) break;
        const uid = Number(msg.uid);
        if (uid <= lastUid) continue; // `X:*` re-lists the highest UID when X > highest
        pending.push({
          uid,
          size: Number(msg.size ?? 0),
          seen: msg.flags instanceof Set ? msg.flags.has('\\Seen') : false,
          internalDate: msg.internalDate ? new Date(msg.internalDate) : null,
          envelope: msg.envelope,
        });
        if (pending.length >= MAX_PER_RUN) break;
      }
      pending.sort((a, b) => a.uid - b.uid);

      let maxUid = lastUid;
      // Oversized messages become a metadata-only row now; the rest get their
      // bodies fetched in pass 2.
      const toFetch = new Map<number, (typeof pending)[number]>();
      for (const p of pending) {
        if (p.size > MAX_MESSAGE_BYTES) {
          await storeOversized(account, uidValidity, p);
          if (p.uid > maxUid) maxUid = p.uid;
        } else {
          toFetch.set(p.uid, p);
        }
      }

      // Pass 2 — download + parse only the in-bound-size bodies. storeMessage
      // throws on any non-duplicate failure; letting it propagate aborts the run
      // before the cursor is saved, so a transient error retries from here
      // instead of skipping the message (finding #2).
      if (toFetch.size > 0) {
        const uidList = [...toFetch.keys()].join(',');
        for await (const msg of client.fetch(uidList, { uid: true, source: true }, { uid: true })) {
          if (signal?.aborted) break;
          const uid = Number(msg.uid);
          const meta = toFetch.get(uid);
          if (!meta || !msg.source) continue;
          await storeMessage(account, uid, uidValidity, msg.source, meta.seen, meta.internalDate);
          if (uid > maxUid) maxUid = uid;
        }
      }

      // Reflect server-side changes (Thunderbird / mobile) back into the CRM over a
      // bounded recent window: \Seen changes, and messages deleted/moved away.
      if (maxUid > 0) {
        await reconcileRecent(client, admin, accountId, uidValidity, Math.max(1, maxUid - RECONCILE_WINDOW));
      }

      const { error: cursorError } = await admin.from('imap_folder_state').upsert(
        {
          account_id: accountId,
          folder: FOLDER,
          uidvalidity: uidValidity,
          last_uid: maxUid,
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: 'account_id,folder' }
      );
      // A dropped cursor write would silently re-import (or, worse, drift): fail
      // the job so it retries. The stores above are idempotent on re-run.
      if (cursorError) {
        throw new Error(`Could not save IMAP cursor for account ${accountId}: ${cursorError.message}`);
      }
    } finally {
      lock.release();
    }
    // Safety net: push any pending write-backs for this account on the same
    // connection (the INBOX lock is released now, so reconcile can re-lock it).
    // This converges even if an interactive reconcile enqueue was lost (#4).
    if (!signal?.aborted) await reconcileWriteback(client, admin, accountId, signal);
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Store one pulled INBOX message as an inbound row via the SHARED inbound
 * recorder, so an IMAP reply gets the same side effects as an Emailit-inbound
 * one: contact match by normalised email, mark the last outbound replied, insert
 * the reply event, stop any "reply"-stop sequences, log the activity. A duplicate
 * (re-run overlap) is a no-op; any other failure THROWS so the caller aborts the
 * run and the cursor is not advanced past this message.
 */
async function storeMessage(
  account: { id: string; from_email: string | null },
  uid: number,
  uidValidity: number,
  source: Buffer,
  seen: boolean,
  internalDate: Date | null
): Promise<void> {
  const parsed = await simpleParser(source);
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
  await recordInboundEmail({
    from: parsed.from?.value?.[0]?.address ?? parsed.from?.text ?? '(unknown sender)',
    to: String(toEmail),
    subject: parsed.subject ?? '',
    html,
    text: parsed.text ?? null,
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    accountId: account.id,
    imap: { uid, folder: FOLDER, uidValidity, seen, internalDate },
  });
}

type ImapAddress = { name?: string; address?: string };
type ImapEnvelope = {
  from?: ImapAddress[];
  sender?: ImapAddress[];
  to?: ImapAddress[];
  subject?: string;
  messageId?: string;
};

/**
 * Store a too-large message as a metadata-only row built from its envelope (no
 * body download/parse), so the cursor advances without losing the email. The
 * user opens the full message in their mail client.
 */
async function storeOversized(
  account: { id: string; from_email: string | null },
  uidValidity: number,
  meta: { uid: number; size: number; seen: boolean; internalDate: Date | null; envelope: unknown }
): Promise<void> {
  const env = (meta.envelope ?? {}) as ImapEnvelope;
  const fromAddr = env.from?.[0]?.address ?? env.sender?.[0]?.address ?? '(unknown sender)';
  const toAddr =
    (env.to ?? [])
      .map((a) => a.address)
      .filter(Boolean)
      .join(', ') ||
    account.from_email ||
    '';
  const mb = (meta.size / (1024 * 1024)).toFixed(1);
  await recordInboundEmail({
    from: fromAddr,
    to: toAddr,
    subject: env.subject ?? '(no subject)',
    html: `<p><em>This message is ${mb}&nbsp;MB — too large to load here. Open it in your mail client.</em></p>`,
    messageId: env.messageId ?? null,
    accountId: account.id,
    imap: { uid: meta.uid, folder: FOLDER, uidValidity, seen: meta.seen, internalDate: meta.internalDate },
  });
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

// Find a special-use mailbox (\\Trash, \\Sent, …) by its SPECIAL-USE flag first,
// then by a name heuristic, so it works across Dovecot / Gmail / etc. layouts.
async function findFolder(client: ImapFlow, special: string, nameRe: RegExp): Promise<string | null> {
  const boxes = await client.list();
  const bySpecial = boxes.find((b) => b.specialUse === special);
  if (bySpecial) return bySpecial.path;
  const byName = boxes.find((b) => nameRe.test(b.path));
  return byName?.path ?? null;
}

/**
 * Dispatch a write-back job: append one outbound message to Sent, or reconcile
 * one account's pending read/delete state. (`id` is a message id for append_sent,
 * an account id for reconcile.)
 */
export async function runImapWriteback(
  op: WritebackOp,
  id: string,
  signal?: AbortSignal
): Promise<void> {
  if (op === 'reconcile') return runImapReconcile(id, signal);

  const admin = createAdminClient();
  const { data: msg } = await admin
    .from('email_messages')
    .select('id, account_id, from_email, to_email, subject, html, message_id, created_at')
    .eq('id', id)
    .maybeSingle();
  if (!msg?.account_id) return;

  const { data: account } = await admin
    .from('email_accounts')
    .select('imap_host, imap_port, imap_username, imap_password, imap_secure, imap_enabled, imap_allow_invalid_cert')
    .eq('id', msg.account_id)
    .maybeSingle();
  if (!account?.imap_enabled || !account.imap_host || !account.imap_password) return;

  const client = newImapClient(account);
  await client.connect();
  try {
    if (signal?.aborted) return;
    const sent = await findFolder(client, '\\Sent', /(^|[./])sent( items| mail)?$/i);
    if (!sent) {
      await logDebug({
        level: 'warn',
        source: 'imap-sync',
        message: `No Sent folder for account ${msg.account_id}; skipped appending message ${msg.id}`,
      }).catch(() => {});
      return;
    }
    // Idempotency: a retried job must not append a second copy. If a message with
    // this Message-ID is already in Sent, we're done.
    if (msg.message_id && (await sentAlreadyHas(client, sent, String(msg.message_id)))) return;

    // Rebuild the RFC822 message with nodemailer's stream transport (builds, does
    // NOT send), then append it to Sent — flagged \Seen and dated to when it went.
    const builder = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const built = await builder.sendMail({
      from: msg.from_email || undefined,
      to: msg.to_email,
      subject: msg.subject || '',
      html: msg.html || '',
      messageId: msg.message_id || undefined,
      date: msg.created_at ? new Date(msg.created_at) : new Date(),
    });
    const raw = (built as unknown as { message: Buffer }).message;
    await client.append(sent, raw, ['\\Seen'], msg.created_at ? new Date(msg.created_at) : undefined);
  } finally {
    await client.logout().catch(() => {});
  }
}

// Is a message with this Message-ID already in the Sent folder? Best effort: a
// server that can't search returns false, so we fall through and append.
async function sentAlreadyHas(client: ImapFlow, sent: string, messageId: string): Promise<boolean> {
  const lock = await client.getMailboxLock(sent);
  try {
    const found = await client.search({ header: { 'message-id': messageId } }, { uid: true });
    return Array.isArray(found) && found.length > 0;
  } catch {
    return false;
  } finally {
    lock.release();
  }
}

/**
 * Per-account: converge the mailbox to the CRM's desired state for this account's
 * synced inbound messages, over ONE connection (finding #4). Opens the account
 * connection, then delegates to reconcileWriteback.
 */
export async function runImapReconcile(accountId: string, signal?: AbortSignal): Promise<void> {
  const admin = createAdminClient();
  const { data: account } = await admin
    .from('email_accounts')
    .select('imap_host, imap_port, imap_username, imap_password, imap_secure, imap_enabled, imap_allow_invalid_cert')
    .eq('id', accountId)
    .maybeSingle();
  if (!account?.imap_enabled || !account.imap_host || !account.imap_password) return;

  const client = newImapClient(account);
  await client.connect();
  try {
    await reconcileWriteback(client, admin, accountId, signal);
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Push each dirty row's CURRENT desired state to the mailbox. Reading the row's
 * live seen/hidden_at at run time (not a queued action) is what makes
 * seen -> unseen -> seen land correctly. Before touching a UID it checks the
 * folder's live UIDVALIDITY, so a stale UID can't hit the wrong message
 * (finding #1). Clears the dirty flag once the mailbox agrees. Shared by the
 * interactive reconcile job and the periodic sync (which reuses its connection).
 */
async function reconcileWriteback(
  client: ImapFlow,
  admin: AdminClient,
  accountId: string,
  signal?: AbortSignal
): Promise<void> {
  const { data: rows } = await admin
    .from('email_messages')
    .select('id, imap_uid, imap_folder, imap_uidvalidity, seen, hidden_at')
    .eq('account_id', accountId)
    .eq('imap_wb_dirty', true)
    .limit(MAX_WB_PER_RUN);
  if (!rows?.length) return;

  const byFolder = new Map<string, typeof rows>();
  for (const r of rows) {
    // Not a synced mailbox message (e.g. an outbound row that got marked read):
    // nothing to push, just clear the flag so it doesn't linger.
    if (r.imap_uid == null || !r.imap_folder) {
      await clearDirty(admin, r.id);
      continue;
    }
    const list = byFolder.get(r.imap_folder) ?? [];
    list.push(r);
    byFolder.set(r.imap_folder, list);
  }

  let trash: string | null | undefined; // resolved lazily, once
  for (const [folder, folderRows] of byFolder) {
    if (signal?.aborted) return;
    const lock = await client.getMailboxLock(folder);
    try {
      const box = client.mailbox;
      const liveValidity = box ? Number(box.uidValidity) : null;
      for (const r of folderRows) {
        if (signal?.aborted) return;
        // Stale generation: the stored UID no longer identifies this message.
        // Acting would hit the wrong one — clear dirty and let a resync
        // re-establish identity under the new UIDVALIDITY (finding #1).
        if (liveValidity !== null && Number(r.imap_uidvalidity) !== liveValidity) {
          await clearDirty(admin, r.id);
          continue;
        }
        const range = String(r.imap_uid);
        try {
          if (r.hidden_at) {
            if (trash === undefined) trash = await findFolder(client, '\\Trash', /(^|[./])trash$/i);
            if (trash) await client.messageMove(range, trash, { uid: true });
            else await client.messageDelete(range, { uid: true });
          } else if (r.seen) {
            await client.messageFlagsAdd(range, ['\\Seen'], { uid: true });
          } else {
            await client.messageFlagsRemove(range, ['\\Seen'], { uid: true });
          }
          await clearDirty(admin, r.id);
        } catch (opError: any) {
          // The UID may already be gone (handled elsewhere): leave dirty so the
          // next reconcile retries, but surface it so it isn't silent.
          await logDebug({
            level: 'warn',
            source: 'imap-sync:writeback',
            message: `Write-back failed for message ${r.id} (uid ${range}): ${opError?.message ?? opError}`,
          }).catch(() => {});
        }
      }
    } finally {
      lock.release();
    }
  }
}

async function clearDirty(admin: AdminClient, id: string): Promise<void> {
  await admin.from('email_messages').update({ imap_wb_dirty: false }).eq('id', id);
}

/** Queue appending one outbound message to Sent (deduped per message). */
export async function enqueueImapAppendSent(messageId: string): Promise<void> {
  await enqueueJob('imap_writeback', { op: 'append_sent', messageId }, `imap-wb:append:${messageId}`, 3);
}

/**
 * Queue a write-back reconcile for one account on a short (15s) bucket, so a
 * burst of read/delete toggles coalesces into one job — yet a change made after
 * the previous job completed still starts a fresh one (the bucket moved), unlike
 * the old permanent per-action key that dropped seen -> unseen -> seen.
 */
export async function enqueueImapReconcile(accountId: string): Promise<void> {
  const bucket = Math.floor(Date.now() / 15_000);
  await enqueueJob(
    'imap_writeback',
    { op: 'reconcile', accountId },
    `imap-wb:reconcile:${accountId}:${bucket}`,
    3
  );
}

/** Queue a sync for each receiving account — at most one per account per bucket. */
export async function enqueueDueImapSyncs(): Promise<{ enqueued: number }> {
  const admin = createAdminClient();
  const { data: accounts, error } = await admin
    .from('email_accounts')
    .select('id')
    .eq('imap_enabled', true);
  if (error) {
    await logDebug({
      level: 'warn',
      source: 'imap-sync',
      message: `Could not list IMAP accounts for periodic sync: ${error.message}`,
    }).catch(() => {});
    return { enqueued: 0 };
  }
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
  const { data: accounts, error } = await admin
    .from('email_accounts')
    .select('id')
    .eq('imap_enabled', true);
  if (error) {
    await logDebug({
      level: 'warn',
      source: 'imap-sync',
      message: `Could not list IMAP accounts for manual sync: ${error.message}`,
    }).catch(() => {});
    return { enqueued: 0 };
  }
  if (!accounts?.length) return { enqueued: 0 };
  const bucket = Math.floor(Date.now() / 20_000);
  let enqueued = 0;
  for (const a of accounts) {
    await enqueueJob('imap_sync', { accountId: a.id }, `imap-sync:${a.id}:manual:${bucket}`, 3);
    enqueued += 1;
  }
  return { enqueued };
}
