-- ---------------------------------------------------------------------------
-- IMAP read sync (Phase 2): pull INBOX mail into email_messages, on the VPS.
-- ---------------------------------------------------------------------------
-- Runs as a heavy-lane job (`imap_sync`) so it lands on the deep-search VPS —
-- the only host with outbound access to the IMAP port. Each run pulls new INBOX
-- messages for one account into email_messages (direction='inbound'), deduped by
-- (account, folder, UID), tracking a per-folder UID cursor. Sending is unchanged.

-- 1. Register the imap_sync job kind.
alter table public.job_queue drop constraint if exists job_queue_kind_check;
alter table public.job_queue
  add constraint job_queue_kind_check check (
    kind in (
      'auto_search', 'deep_search', 'contact_enrichment', 'score_contact',
      'email_delivery', 'sms_delivery', 'voicemail_delivery',
      'notification_delivery', 'contact_side_effects', 'link_recheck', 'imap_sync'
    )
  );

-- 2. Keep imap_sync OFF the light lane: it opens a network connection to the
--    mail host and can run for seconds, so it belongs on the heavy lane with the
--    searches, not the delivery batch. (Body copied from 0038 + imap_sync.)
create or replace function public.claim_light_jobs(
  p_worker text,
  p_limit int default 20,
  p_lease_seconds int default 150
)
returns setof public.job_queue
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimable as (
    select
      j.id,
      case j.kind
        when 'email_delivery' then 0
        when 'sms_delivery' then 0
        when 'voicemail_delivery' then 0
        when 'notification_delivery' then 0
        when 'contact_enrichment' then 5
        when 'contact_side_effects' then 5
        when 'score_contact' then 9
        else 5
      end as prio
    from public.job_queue j
    where j.kind not in ('deep_search', 'auto_search', 'link_recheck', 'imap_sync')
      and j.attempt_count < j.max_attempts
      and j.available_at <= now()
      and (
        j.status = 'pending'
        or (
          j.status = 'processing'
          and (
            j.locked_at is null
            or j.locked_at < now() - make_interval(secs => p_lease_seconds)
          )
        )
      )
    order by prio, j.available_at, j.created_at
    for update of j skip locked
    limit least(greatest(p_limit, 1), 100)
  )
  update public.job_queue j
  set status = 'processing',
      attempt_count = j.attempt_count + 1,
      locked_at = now(),
      locked_by = p_worker,
      updated_at = now()
  from claimable
  where j.id = claimable.id
  returning j.*;
end;
$$;

revoke all on function public.claim_light_jobs(text, int, int) from public, anon, authenticated;
grant execute on function public.claim_light_jobs(text, int, int) to service_role;

-- 3. Synced-message columns on email_messages, plus a dedup index. The unique
--    (account, folder, UID) index makes a re-run overlap a no-op (23505). hidden_at
--    is the soft-delete used by the delete feature in a later phase.
alter table public.email_messages
  add column if not exists imap_uid bigint,
  add column if not exists imap_folder text,
  add column if not exists imap_uidvalidity bigint,
  add column if not exists hidden_at timestamptz;

create unique index if not exists email_messages_imap_uid_idx
  on public.email_messages (account_id, imap_folder, imap_uid)
  where imap_uid is not null;

-- 4. Per-folder sync cursor (UIDVALIDITY + last UID seen). Service-role only —
--    the browser never reads it.
create table if not exists public.imap_folder_state (
  account_id uuid not null references public.email_accounts (id) on delete cascade,
  folder text not null,
  uidvalidity bigint,
  last_uid bigint not null default 0,
  last_synced_at timestamptz,
  primary key (account_id, folder)
);

alter table public.imap_folder_state enable row level security;
revoke all on table public.imap_folder_state from public, anon, authenticated;
grant select, insert, update, delete on table public.imap_folder_state to service_role;
