-- 0028: lease-safe deep-search attempts and atomic visible state.
--
-- A contact may have several intentionally distinct focused searches queued
-- back-to-back. They must run in order, and only the exact worker attempt that
-- owns the queue lease may commit results or terminal failure.

alter table public.contacts
  add column if not exists deep_search_flag_job_id uuid;

create index if not exists job_queue_active_deep_search_contact_idx
  on public.job_queue ((lower(payload ->> 'contactId')), created_at, id)
  where kind = 'deep_search' and status in ('pending', 'processing');

comment on column public.contacts.deep_search_flag_job_id is
  'Provenance for a search_flag written by deep search; no FK so retention may prune the job.';

-- Existing auto-search and admin actions also use search_flag. If one of them
-- replaces a deep-search message without deliberately replacing provenance,
-- mark the new value as unrelated so a later clean deep run preserves it.
create or replace function public.reset_deep_search_flag_provenance()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.search_flag is distinct from old.search_flag
     and new.deep_search_flag_job_id is not distinct from old.deep_search_flag_job_id then
    new.deep_search_flag_job_id := null;
  end if;
  return new;
end;
$$;

drop trigger if exists reset_deep_search_flag_provenance on public.contacts;
create trigger reset_deep_search_flag_provenance
before update of search_flag on public.contacts
for each row execute function public.reset_deep_search_flag_provenance();

revoke all on function public.reset_deep_search_flag_provenance()
  from public, anon, authenticated;

-- Queue insertion and the contact's amber stamp are one transaction. A
-- duplicate pending job reuses the active row, while retrying a failed
-- duplicate preserves it as history and creates a fresh attempt generation.
create or replace function public.enqueue_deep_search_job(
  p_contact_id uuid,
  p_actor_id uuid,
  p_focus_date date,
  p_dedupe_key text,
  p_max_attempts int default 2
)
returns table (
  id uuid,
  queued boolean,
  duplicate boolean,
  retried boolean,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
  v_status text;
  v_kind text;
  v_pointer_id uuid;
  v_queued boolean := false;
  v_duplicate boolean := false;
  v_retried boolean := false;
  v_payload jsonb;
begin
  if nullif(btrim(p_dedupe_key), '') is null then
    raise exception 'Deep-search dedupe key is required';
  end if;
  if p_max_attempts < 1 or p_max_attempts > 20 then
    raise exception 'Deep-search max attempts must be between 1 and 20';
  end if;

  -- Shared with completion/failure so enqueue cannot race a pointer refresh.
  perform pg_advisory_xact_lock(
    hashtextextended('deep-search:' || p_contact_id::text, 0)
  );
  perform 1 from public.contacts where contacts.id = p_contact_id for update;
  if not found then
    raise exception 'Contact % does not exist', p_contact_id using errcode = 'P0002';
  end if;

  v_payload := jsonb_strip_nulls(
    jsonb_build_object(
      'contactId', p_contact_id::text,
      'actorId', p_actor_id::text,
      'focusDate', p_focus_date
    )
  );

  select j.id, j.status, j.kind
    into v_job_id, v_status, v_kind
  from public.job_queue j
  where j.dedupe_key = p_dedupe_key
  for update;

  if found then
    if v_kind <> 'deep_search' then
      raise exception 'Dedupe key belongs to a different job kind';
    end if;
    if v_status = 'failed' then
      -- Keep the failed row as immutable history and create a fresh generation.
      -- Reusing its id and resetting attempt_count would repeat provider usage
      -- keys such as job:<id>:attempt:1 and under-count the retried calls.
      update public.job_queue j
      set
        dedupe_key = p_dedupe_key || ':retired:' || v_job_id::text,
        updated_at = now()
      where j.id = v_job_id;

      insert into public.job_queue (
        kind, payload, dedupe_key, max_attempts
      )
      values (
        'deep_search', v_payload, p_dedupe_key, p_max_attempts
      )
      returning job_queue.id, job_queue.status into v_job_id, v_status;

      v_status := 'pending';
      v_queued := true;
      v_retried := true;
    else
      v_duplicate := true;
    end if;
  else
    insert into public.job_queue (
      kind, payload, dedupe_key, max_attempts
    )
    values (
      'deep_search', v_payload, p_dedupe_key, p_max_attempts
    )
    returning job_queue.id, job_queue.status into v_job_id, v_status;
    v_queued := true;
  end if;

  -- Point at the oldest active sibling, not simply the newest enqueue. This
  -- keeps multiple focused runs visible without invalidating the earlier one.
  select j.id
    into v_pointer_id
  from public.job_queue j
  where j.kind = 'deep_search'
    and j.status in ('pending', 'processing')
    and lower(j.payload ->> 'contactId') = p_contact_id::text
  order by j.created_at, j.id
  limit 1;

  update public.contacts c
  set
    deep_search_job_id = v_pointer_id,
    deep_search_queued_at = case
      when v_pointer_id is null then null
      when c.deep_search_job_id is distinct from v_pointer_id then now()
      else coalesce(c.deep_search_queued_at, now())
    end
  where c.id = p_contact_id;

  return query
    select v_job_id, v_queued, v_duplicate, v_retried, v_status;
end;
$$;

revoke all on function public.enqueue_deep_search_job(uuid, uuid, date, text, int)
  from public, anon, authenticated;
grant execute on function public.enqueue_deep_search_job(uuid, uuid, date, text, int)
  to service_role;

-- Commit the contact results and queue completion together. The job row is
-- locked and checked against all three pieces of attempt identity.
create or replace function public.finish_deep_search_attempt(
  p_contact_id uuid,
  p_job_id uuid,
  p_worker text,
  p_attempt_count int,
  p_search_facts jsonb,
  p_search_flag text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
  v_next_job_id uuid;
  v_flag text := nullif(btrim(p_search_flag), '');
begin
  perform pg_advisory_xact_lock(
    hashtextextended('deep-search:' || p_contact_id::text, 0)
  );
  perform 1
  from public.contacts c
  where c.id = p_contact_id
  for update;
  if not found then
    raise exception 'Contact % disappeared while completing deep search', p_contact_id;
  end if;

  select j.payload
    into v_payload
  from public.job_queue j
  where j.id = p_job_id
    and j.kind = 'deep_search'
    and j.status = 'processing'
    and j.locked_by = p_worker
    and j.attempt_count = p_attempt_count
  for update;
  if not found or lower(v_payload ->> 'contactId') is distinct from p_contact_id::text then
    return false;
  end if;

  update public.job_queue j
  set
    status = 'completed',
    locked_at = null,
    locked_by = null,
    last_error = null,
    completed_at = now(),
    updated_at = now()
  where j.id = p_job_id
    and j.status = 'processing'
    and j.locked_by = p_worker
    and j.attempt_count = p_attempt_count;
  if not found then return false; end if;

  select j.id
    into v_next_job_id
  from public.job_queue j
  where j.kind = 'deep_search'
    and j.status in ('pending', 'processing')
    and lower(j.payload ->> 'contactId') = p_contact_id::text
  order by j.created_at, j.id
  limit 1;

  update public.contacts c
  set
    search_facts = coalesce(p_search_facts, '{}'::jsonb),
    search_flag = case
      when v_flag is not null then left(v_flag, 500)
      when c.deep_search_flag_job_id is not null
        or c.search_flag like 'Multiple identities found (%'
        or c.search_flag like 'Not yet indexed on %'
        or c.search_flag like 'the last deep search failed after %'
        then null
      else c.search_flag
    end,
    search_flagged_at = case
      when v_flag is not null then now()
      when c.deep_search_flag_job_id is not null
        or c.search_flag like 'Multiple identities found (%'
        or c.search_flag like 'Not yet indexed on %'
        or c.search_flag like 'the last deep search failed after %'
        then null
      else c.search_flagged_at
    end,
    deep_search_flag_job_id = case when v_flag is not null then p_job_id else null end,
    deep_searched_at = now(),
    deep_search_job_id = v_next_job_id,
    deep_search_queued_at = case
      when v_next_job_id is null then null
      else now()
    end
  where c.id = p_contact_id;
  return true;
end;
$$;

revoke all on function public.finish_deep_search_attempt(uuid, uuid, text, int, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.finish_deep_search_attempt(uuid, uuid, text, int, jsonb, text)
  to service_role;

-- Terminal failure is the same atomic operation: mark the exact queue attempt
-- failed, surface its reason, and leave the contact amber when a sibling run is
-- still waiting.
create or replace function public.fail_deep_search_attempt(
  p_contact_id uuid,
  p_job_id uuid,
  p_worker text,
  p_attempt_count int,
  p_message text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
  v_contact_id uuid;
  v_pointer_match boolean := false;
  v_next_job_id uuid;
begin
  -- A malformed legacy payload may not supply a castable contact id. Resolve
  -- from the visible queue pointer first, then the normalized payload or the
  -- caller hint. Contact state is optional; the exact leased job must still be
  -- terminally failed when its contact has disappeared.
  select c.id, c.deep_search_job_id = p_job_id
    into v_contact_id, v_pointer_match
  from public.contacts c
  where c.deep_search_job_id = p_job_id
     or c.id = p_contact_id
     or exists (
       select 1
       from public.job_queue candidate
       where candidate.id = p_job_id
         and lower(candidate.payload ->> 'contactId') = c.id::text
     )
  order by case
    when c.deep_search_job_id = p_job_id then 0
    when exists (
      select 1
      from public.job_queue candidate
      where candidate.id = p_job_id
        and lower(candidate.payload ->> 'contactId') = c.id::text
    ) then 1
    else 2
  end
  limit 1;

  if v_contact_id is not null then
    perform pg_advisory_xact_lock(
      hashtextextended('deep-search:' || v_contact_id::text, 0)
    );
    perform 1
    from public.contacts c
    where c.id = v_contact_id
    for update;
  end if;

  select j.payload
    into v_payload
  from public.job_queue j
  where j.id = p_job_id
    and j.kind = 'deep_search'
    and j.status = 'processing'
    and j.locked_by = p_worker
    and j.attempt_count = p_attempt_count
  for update;
  if not found then
    return false;
  end if;
  if v_contact_id is not null
     and lower(v_payload ->> 'contactId') is distinct from v_contact_id::text
     and not v_pointer_match then
    return false;
  end if;
  if v_contact_id is null
     and p_contact_id is not null
     and lower(v_payload ->> 'contactId') is distinct from p_contact_id::text then
    return false;
  end if;

  update public.job_queue j
  set
    status = 'failed',
    locked_at = null,
    locked_by = null,
    last_error = left(coalesce(nullif(btrim(p_message), ''), 'Deep search failed'), 2000),
    updated_at = now()
  where j.id = p_job_id
    and j.status = 'processing'
    and j.locked_by = p_worker
    and j.attempt_count = p_attempt_count;
  if not found then return false; end if;

  if v_contact_id is not null then
    select j.id
      into v_next_job_id
    from public.job_queue j
    where j.kind = 'deep_search'
      and j.status in ('pending', 'processing')
      and lower(j.payload ->> 'contactId') = v_contact_id::text
    order by j.created_at, j.id
    limit 1;

    update public.contacts c
    set
      search_flag = left(coalesce(nullif(btrim(p_message), ''), 'Deep search failed'), 500),
      search_flagged_at = now(),
      deep_search_flag_job_id = p_job_id,
      deep_search_job_id = v_next_job_id,
      deep_search_queued_at = case
        when v_next_job_id is null then null
        else now()
      end
    where c.id = v_contact_id;
  end if;
  return true;
end;
$$;

revoke all on function public.fail_deep_search_attempt(uuid, uuid, text, int, text)
  from public, anon, authenticated;
grant execute on function public.fail_deep_search_attempt(uuid, uuid, text, int, text)
  to service_role;

-- A BEFORE DELETE trigger already owns the contact row. Do not lock queue rows
-- before checking for processing work: completion deliberately locks contact
-- then job. The second check closes the pending->processing race after pending
-- rows are cancelled, without introducing the inverse job->contact order.
create or replace function public.cancel_jobs_for_deleted_contact()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.job_queue j
    where j.status = 'processing'
      and (
        lower(j.payload ->> 'contactId') = old.id::text
        or old.deep_search_job_id = j.id
      )
  ) then
    raise exception 'Contact has background work in progress; retry when it finishes';
  end if;

  update public.job_queue j
  set
    status = 'failed',
    locked_at = null,
    locked_by = null,
    last_error = 'Contact was deleted or merged',
    updated_at = now()
  where j.status = 'pending'
    and (
      lower(j.payload ->> 'contactId') = old.id::text
      or old.deep_search_job_id = j.id
    );

  if exists (
    select 1
    from public.job_queue j
    where j.status = 'processing'
      and (
        lower(j.payload ->> 'contactId') = old.id::text
        or old.deep_search_job_id = j.id
      )
  ) then
    raise exception 'Contact acquired background work during deletion; retry when it finishes';
  end if;
  return old;
end;
$$;

-- The 0027 RPCs only checked a contact/job pair. Keeping them executable would
-- leave a bypass around the worker + attempt lease checks above.
drop function if exists public.finish_deep_search_state(uuid, uuid, jsonb, text, boolean);
drop function if exists public.fail_deep_search_state(uuid, uuid, text);

-- Reclaim stale jobs while preserving per-contact FIFO serialization for deep
-- search. A second worker cannot SKIP LOCKED past the first focused sibling and
-- claim another run for the same contact.
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

revoke all on function public.claim_jobs(text, int, int) from public, anon, authenticated;
grant execute on function public.claim_jobs(text, int, int) to service_role;
