-- Finding #8: imap_sync / imap_writeback shared the single heavy lane with deep
-- searches and link checks (one job per tick), so IMAP could starve behind a
-- deep search — and any host running the heavy drain could claim IMAP work.
--
-- Give IMAP its own lane: claim_imap_jobs claims ONLY imap kinds, and claim_jobs
-- (the browser-heavy lane) now EXCLUDES them. The cron tick drains the two lanes
-- in parallel (skip-locked keeps that safe), so IMAP throughput no longer trades
-- off against deep searches.

-- IMAP-only claimer (mirrors claim_light_jobs' shape; no deep-search sibling rule).
create or replace function public.claim_imap_jobs(
  p_worker text,
  p_limit int default 3,
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
    select j.id
    from public.job_queue j
    where j.kind in ('imap_sync', 'imap_writeback')
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
    order by j.available_at, j.created_at
    for update of j skip locked
    limit least(greatest(p_limit, 1), 20)
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

revoke all on function public.claim_imap_jobs(text, int, int) from public, anon, authenticated;
grant execute on function public.claim_imap_jobs(text, int, int) to service_role;

-- Re-state claim_jobs EXACTLY as in 0028, with a single added condition so the
-- heavy lane no longer claims IMAP kinds (they have their own lane above).
create or replace function public.claim_jobs(
  p_worker text,
  p_limit int default 2,
  p_lease_seconds int default 150
)
returns setof public.job_queue
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact_key text;
  v_exhausted record;
  v_next_job_id uuid;
begin
  -- Completion and enqueue take this same lock before touching either table.
  -- Acquire locks in a stable order before expiring rows, so a concurrent
  -- enqueue cannot be hidden by the snapshot that performs terminal cleanup.
  for v_contact_key in
    select distinct c.id::text
    from public.job_queue j
    join public.contacts c
      on c.id::text = lower(nullif(j.payload ->> 'contactId', ''))
      or c.deep_search_job_id = j.id
    where j.kind = 'deep_search'
      and j.status = 'processing'
      and j.attempt_count >= j.max_attempts
      and (
        j.locked_at is null
        or j.locked_at < now() - make_interval(secs => p_lease_seconds)
      )
    order by 1
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('deep-search:' || v_contact_key, 0)
    );
    perform 1
    from public.contacts c
    where c.id::text = v_contact_key
    for update;
  end loop;

  for v_exhausted in
    update public.job_queue
    set status = 'failed',
        locked_at = null,
        locked_by = null,
        last_error = coalesce(last_error, 'Worker lease expired after final attempt'),
        updated_at = now()
    where status = 'processing'
      and attempt_count >= max_attempts
      and (
        locked_at is null
        or locked_at < now() - make_interval(secs => p_lease_seconds)
      )
    returning id, kind, payload, attempt_count, last_error
  loop
    if v_exhausted.kind = 'deep_search' then
      v_contact_key := null;
      select c.id::text
        into v_contact_key
      from public.contacts c
      where c.id::text = lower(nullif(v_exhausted.payload ->> 'contactId', ''))
         or c.deep_search_job_id = v_exhausted.id
      order by case when c.deep_search_job_id = v_exhausted.id then 0 else 1 end
      limit 1;

      if v_contact_key is null then
        continue;
      end if;

      select sibling.id
        into v_next_job_id
      from public.job_queue sibling
      where sibling.kind = 'deep_search'
        and sibling.status in ('pending', 'processing')
        and lower(sibling.payload ->> 'contactId') = v_contact_key
      order by sibling.created_at, sibling.id
      limit 1;

      -- Compare UUIDs as text so a malformed legacy payload is failed and
      -- logged without raising a cast error that blocks every other claim.
      update public.contacts c
      set
        deep_search_job_id = v_next_job_id,
        deep_search_queued_at = case
          when v_next_job_id is null then null
          else now()
        end,
        search_flag = left(
          'the last deep search failed after ' || v_exhausted.attempt_count::text ||
          ' attempts (' || coalesce(v_exhausted.last_error, 'lease expired') || ')',
          500
        ),
        search_flagged_at = now(),
        deep_search_flag_job_id = v_exhausted.id
      where c.id::text = v_contact_key;
    end if;
  end loop;

  return query
  with claimable as (
    select j.id
    from public.job_queue j
    where j.attempt_count < j.max_attempts
      -- #8: IMAP kinds are claimed by claim_imap_jobs, not the heavy lane.
      and j.kind not in ('imap_sync', 'imap_writeback')
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
      and (
        j.kind <> 'deep_search'
        or j.id = (
          select sibling.id
          from public.job_queue sibling
          where sibling.kind = 'deep_search'
            and sibling.status in ('pending', 'processing')
            and coalesce(lower(sibling.payload ->> 'contactId'), '__missing__') =
                coalesce(lower(j.payload ->> 'contactId'), '__missing__')
          order by sibling.created_at, sibling.id
          limit 1
        )
      )
    order by j.available_at, j.created_at
    for update of j skip locked
    limit least(greatest(p_limit, 1), 10)
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
