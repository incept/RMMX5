-- ---------------------------------------------------------------------------
-- IMAP write-back (Phase 3): two-way sync of read state + deletes.
-- ---------------------------------------------------------------------------
-- The CRM now writes changes back to the mailbox so Thunderbird / mobile stay in
-- sync: opening a message flags \Seen on the server; deleting moves it to Trash.
-- The reverse direction (server \Seen / deletions reflected into the CRM) is
-- reconciled on each imap_sync run. Write-back runs as its own heavy-lane job.

-- 1. Read state for inbound mail. Synced from the server \Seen flag; set true when
--    opened in the CRM (which also flags \Seen on the server via write-back).
alter table public.email_messages
  add column if not exists seen boolean not null default false;

-- 2. Register the imap_writeback job kind.
alter table public.job_queue drop constraint if exists job_queue_kind_check;
alter table public.job_queue
  add constraint job_queue_kind_check check (
    kind in (
      'auto_search', 'deep_search', 'contact_enrichment', 'score_contact',
      'email_delivery', 'sms_delivery', 'voicemail_delivery',
      'notification_delivery', 'contact_side_effects', 'link_recheck',
      'imap_sync', 'imap_writeback'
    )
  );

-- 3. Keep imap_writeback OFF the light lane (heavy-only; opens an IMAP connection
--    to the mail host). Body from 0045 + imap_writeback in the exclusion.
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
    where j.kind not in ('deep_search', 'auto_search', 'link_recheck', 'imap_sync', 'imap_writeback')
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
