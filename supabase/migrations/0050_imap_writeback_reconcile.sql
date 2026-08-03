-- Finding #4: write-back was one job per action per message, with permanent
-- dedupe keys (so seen -> unseen -> seen dropped the second seen) and a bulk
-- delete could enqueue hundreds of single-connection jobs into the 1-per-tick
-- heavy lane. Replace that with a per-account reconciler that converges the
-- mailbox to the CRM's desired state over ONE connection.
--
-- imap_wb_dirty marks a synced inbound row whose read/deleted state changed in
-- the CRM and hasn't been pushed to the mailbox yet. It is set in the SAME
-- update that changes seen/hidden_at (so there is never a hidden row with no
-- pending mailbox op), and cleared by the reconciler once the mailbox agrees.
alter table public.email_messages
  add column if not exists imap_wb_dirty boolean not null default false;

-- Find the accounts/rows with pending write-back cheaply.
create index if not exists email_messages_imap_wb_dirty_idx
  on public.email_messages (account_id)
  where imap_wb_dirty;
