-- Preserve a failed/partial sibling's visible warning while focused deep
-- searches continue. A clean, ordinary (unfocused) secondary search is the
-- deliberate operation that clears accumulated deep-search warnings.
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
  v_existing_flag_job_id uuid;
  v_existing_flag text;
  v_preserve_existing_flag boolean := false;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('deep-search:' || p_contact_id::text, 0)
  );
  select c.deep_search_flag_job_id, c.search_flag
    into v_existing_flag_job_id, v_existing_flag
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

  -- A focused branch is only one slice of the person's history and therefore
  -- cannot erase a warning raised by another slice. An ordinary run may clear
  -- accumulated warnings only when it completed cleanly.
  v_preserve_existing_flag :=
    v_existing_flag_job_id is not null
    and (
      nullif(v_payload ->> 'focusDate', '') is not null
      or v_flag is not null
    );

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
      when v_preserve_existing_flag and v_flag is not null
        then left(concat_ws(' | ', nullif(btrim(v_existing_flag), ''), v_flag), 500)
      when v_preserve_existing_flag then c.search_flag
      when v_flag is not null then left(v_flag, 500)
      when c.deep_search_flag_job_id is not null
        or c.search_flag like 'Multiple identities found (%'
        or c.search_flag like 'Not yet indexed on %'
        or c.search_flag like 'Partial deep search:%'
        or c.search_flag like 'the last deep search failed after %'
        then null
      else c.search_flag
    end,
    search_flagged_at = case
      when v_preserve_existing_flag and v_flag is not null then now()
      when v_preserve_existing_flag then c.search_flagged_at
      when v_flag is not null then now()
      when c.deep_search_flag_job_id is not null
        or c.search_flag like 'Multiple identities found (%'
        or c.search_flag like 'Not yet indexed on %'
        or c.search_flag like 'Partial deep search:%'
        or c.search_flag like 'the last deep search failed after %'
        then null
      else c.search_flagged_at
    end,
    deep_search_flag_job_id = case
      when v_preserve_existing_flag then c.deep_search_flag_job_id
      when v_flag is not null then p_job_id
      else null
    end,
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
