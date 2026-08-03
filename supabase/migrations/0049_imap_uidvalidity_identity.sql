-- Finding #1: an IMAP UID is only unique within a UIDVALIDITY generation. The
-- 0045 dedup index keyed on (account, folder, uid) only, so after a mailbox
-- rebuild (UIDVALIDITY changes) a reused UID collided with a historical CRM row
-- and the new message was silently dropped as a "duplicate". Fold
-- imap_uidvalidity into the identity so a UID under a new generation is a
-- distinct message. The write-back path also compares the live UIDVALIDITY
-- before acting, so a stale UID can't flag/delete the wrong server message.
drop index if exists public.email_messages_imap_uid_idx;

create unique index if not exists email_messages_imap_uid_idx
  on public.email_messages (account_id, imap_folder, imap_uidvalidity, imap_uid)
  where imap_uid is not null;
