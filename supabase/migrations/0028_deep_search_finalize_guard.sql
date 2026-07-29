-- ---------------------------------------------------------------------------
-- Fix the deep-search finalize guard (0027 follow-up).
--
-- 0027 keyed both finalize functions on contacts.deep_search_job_id — a single
-- slot the enqueue route rewrites on every click. Two legitimate live runs
-- exist the moment an admin branches a multi-arrest contact (one job per
-- booking date): each branch click overwrote the slot, so every run except the
-- LAST did its full 95-second sweep, found the slot naming a different job,
-- threw "superseded", retried (spending the providers again), and parked as
-- failed. The queue looked stuck while discarding finished work.
--
-- The guard's real question is not "does a stamp still name me?" but "do I
-- still hold a live claim?" — and the job row itself knows that. The zombie
-- this guard exists for (a lease-lost worker writing after its job was
-- reclaimed) is still rejected, because its job is no longer processing.
-- ---------------------------------------------------------------------------

create or replace function public.finish_deep_search_state(
  p_contact_id uuid,
  p_job_id uuid,
  p_search_facts jsonb,
  p_search_flag text,
  p_flag_changed boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Lease-lost zombie: the job was reclaimed or finished by someone else.
  -- Whatever run owns the claim now also owns the contact's search state.
  if not exists (
    select 1 from public.job_queue j
    where j.id = p_job_id and j.status = 'processing'
  ) then
    return false;
  end if;

  update public.contacts
  set
    search_facts = coalesce(p_search_facts, '{}'::jsonb),
    search_flag = case when p_flag_changed then nullif(btrim(p_search_flag), '') else search_flag end,
    search_flagged_at = case
      when p_flag_changed and nullif(btrim(p_search_flag), '') is not null then now()
      when p_flag_changed then null
      else search_flagged_at
    end,
    deep_searched_at = now(),
    -- Amber goes out only when no OTHER live run still owns it, so branching a
    -- multi-arrest contact keeps the icon honest until the last branch lands.
    deep_search_queued_at = case when exists (
      select 1 from public.job_queue j
      where j.kind = 'deep_search'
        and j.id <> p_job_id
        and j.status in ('pending', 'processing')
        and (j.payload ->> 'contactId')::uuid = p_contact_id
    ) then deep_search_queued_at else null end,
    deep_search_job_id = case
      when deep_search_job_id = p_job_id then null
      else deep_search_job_id
    end
  where id = p_contact_id;
  return found;
end;
$$;

create or replace function public.fail_deep_search_state(
  p_contact_id uuid,
  p_job_id uuid,
  p_message text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  -- No processing-liveness check here: the caller records the terminal failure
  -- first (guarded by its worker lease), so by the time this runs the job is
  -- already 'failed' — and that is the one caller allowed to say so.
  update public.contacts
  set
    deep_search_queued_at = case when exists (
      select 1 from public.job_queue j
      where j.kind = 'deep_search'
        and j.id <> p_job_id
        and j.status in ('pending', 'processing')
        and (j.payload ->> 'contactId')::uuid = p_contact_id
    ) then deep_search_queued_at else null end,
    deep_search_job_id = case
      when deep_search_job_id = p_job_id then null
      else deep_search_job_id
    end,
    search_flag = left(p_message, 500),
    search_flagged_at = now()
  where id = p_contact_id;
  return found;
end;
$$;

revoke all on function public.finish_deep_search_state(uuid, uuid, jsonb, text, boolean)
  from public, anon, authenticated;
revoke all on function public.fail_deep_search_state(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.finish_deep_search_state(uuid, uuid, jsonb, text, boolean)
  to service_role;
grant execute on function public.fail_deep_search_state(uuid, uuid, text)
  to service_role;
