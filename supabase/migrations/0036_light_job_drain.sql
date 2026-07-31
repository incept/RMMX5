-- Priority queue draining. The tick processed one job per tick, FIFO by
-- created_at, so a client import's hundreds of score_contact jobs buried
-- anything queued after them (an email_delivery, an SMS) behind the whole
-- backlog — at one-per-tick that is hours.
--
-- This claims every kind EXCEPT the Chrome-owning searches (deep_search,
-- auto_search — those stay on the one-per-tick claim_jobs path) in a batch,
-- ordered by PRIORITY: user-facing deliveries first, scoring last. Re-rank a
-- kind by editing the case map below. skip-locked keeps it safe to run
-- alongside claim_jobs.
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
      -- Priority tiers, lower runs sooner. Edit to re-rank a kind.
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
    where j.kind not in ('deep_search', 'auto_search')
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
