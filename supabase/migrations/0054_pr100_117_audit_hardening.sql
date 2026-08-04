-- Audit hardening for PRs 100-117.
--
-- This migration closes four boundaries that application-only checks cannot:
--   * only admins may mutate marketing automation state;
--   * inbound reply side effects are finalized transactionally and idempotently;
--   * engagement counting and sequence stopping happen in one transaction;
--   * queued work and uploaded email assets have explicit ownership/lifecycle.

-- ---------------------------------------------------------------------------
-- Marketing automation is readable by the active team, but only administrators
-- may change content or scheduling. The cron worker uses service_role and is
-- unaffected. This prevents a worker browser session from editing a sequence
-- directly through PostgREST and having the privileged cron process send it.
-- ---------------------------------------------------------------------------

drop policy if exists "templates all" on public.email_templates;
drop policy if exists "lists all" on public.email_lists;
drop policy if exists "list members all" on public.email_list_members;
drop policy if exists "sequences all" on public.email_sequences;
drop policy if exists "steps all" on public.sequence_steps;
drop policy if exists "enrollments all" on public.sequence_enrollments;
drop policy if exists "templates select" on public.email_templates;
drop policy if exists "templates write" on public.email_templates;
drop policy if exists "lists select" on public.email_lists;
drop policy if exists "lists write" on public.email_lists;
drop policy if exists "list members select" on public.email_list_members;
drop policy if exists "list members write" on public.email_list_members;
drop policy if exists "sequences select" on public.email_sequences;
drop policy if exists "sequences write" on public.email_sequences;
drop policy if exists "steps select" on public.sequence_steps;
drop policy if exists "steps write" on public.sequence_steps;
drop policy if exists "enrollments select" on public.sequence_enrollments;
drop policy if exists "enrollments write" on public.sequence_enrollments;

create policy "templates select" on public.email_templates for select
  using (public.is_active());
create policy "templates write" on public.email_templates for all
  using (public.is_admin()) with check (public.is_admin());

create policy "lists select" on public.email_lists for select
  using (public.is_active());
create policy "lists write" on public.email_lists for all
  using (public.is_admin()) with check (public.is_admin());

create policy "list members select" on public.email_list_members for select
  using (public.is_active());
create policy "list members write" on public.email_list_members for all
  using (public.is_admin()) with check (public.is_admin());

create policy "sequences select" on public.email_sequences for select
  using (public.is_active());
create policy "sequences write" on public.email_sequences for all
  using (public.is_admin()) with check (public.is_admin());

create policy "steps select" on public.sequence_steps for select
  using (public.is_active());
create policy "steps write" on public.sequence_steps for all
  using (public.is_admin()) with check (public.is_admin());

create policy "enrollments select" on public.sequence_enrollments for select
  using (public.is_active());
create policy "enrollments write" on public.sequence_enrollments for all
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Idempotent inbound reply finalization.
-- Existing inbound rows are marked complete so deploying this migration never
-- replays historical reply activity. New rows start pending and are finalized
-- by finalize_inbound_email_effects() under a row lock.
-- ---------------------------------------------------------------------------

alter table public.email_messages
  add column if not exists inbound_effects_applied boolean not null default false,
  add column if not exists provider_message_id text;

update public.email_messages
set inbound_effects_applied = true
where direction = 'inbound' and inbound_effects_applied = false;

create unique index if not exists email_messages_provider_message_id_idx
  on public.email_messages (provider_message_id)
  where provider_message_id is not null;

create or replace function public.finalize_inbound_email_effects(p_message_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message public.email_messages%rowtype;
  v_outbound_id uuid;
begin
  select * into v_message
  from public.email_messages
  where id = p_message_id
  for update;

  if not found then
    raise exception 'Inbound email % does not exist', p_message_id;
  end if;
  if v_message.direction <> 'inbound' then
    raise exception 'Email % is not inbound', p_message_id;
  end if;
  if v_message.inbound_effects_applied then
    return false;
  end if;

  if v_message.contact_id is not null then
    select id into v_outbound_id
    from public.email_messages
    where contact_id = v_message.contact_id and direction = 'outbound'
    order by created_at desc
    limit 1;

    if v_outbound_id is not null then
      update public.email_messages set replied = true where id = v_outbound_id;
      insert into public.email_events (message_id, contact_id, type, meta)
      values (
        v_outbound_id,
        v_message.contact_id,
        'reply',
        jsonb_build_object('inbound_message_id', v_message.id)
      );
    end if;

    update public.sequence_enrollments se
    set status = 'stopped', stop_reason = 'reply'
    from public.email_sequences es
    where se.sequence_id = es.id
      and se.contact_id = v_message.contact_id
      and se.status = 'active'
      and 'reply' = any(es.stop_on);

    insert into public.activity_log (contact_id, actor_id, type, description, meta)
    values (
      v_message.contact_id,
      null,
      'email',
      left(
        'Reply received from ' || v_message.from_email || ': "' || coalesce(v_message.subject, '') || '"',
        2000
      ),
      jsonb_build_object('message_row_id', v_message.id)
    );
  end if;

  update public.email_messages
  set inbound_effects_applied = true
  where id = p_message_id;
  return true;
end;
$$;

revoke all on function public.finalize_inbound_email_effects(uuid)
  from public, anon, authenticated;
grant execute on function public.finalize_inbound_email_effects(uuid) to service_role;

-- Count an engagement event and apply its automation stop in the same
-- transaction. The stop is intentionally idempotent and also runs for a
-- bucket-duplicate event, so a retried webhook can finish an earlier stop.
create or replace function public.track_email_event_and_stop(
  p_message_id uuid,
  p_event text,
  p_url text default null,
  p_bucket_seconds int default 60
)
returns table (message_id uuid, contact_id uuid, counted boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result record;
begin
  select * into v_result
  from public.track_email_event_bounded(
    p_message_id,
    p_event,
    p_url,
    p_bucket_seconds
  );

  if not found then return; end if;

  if v_result.contact_id is not null then
    update public.sequence_enrollments se
    set status = 'stopped', stop_reason = p_event
    from public.email_sequences es
    where se.sequence_id = es.id
      and se.contact_id = v_result.contact_id
      and se.status = 'active'
      and p_event = any(es.stop_on);
  end if;

  return query
    select v_result.message_id, v_result.contact_id, v_result.counted;
end;
$$;

revoke all on function public.track_email_event_and_stop(uuid, text, text, int)
  from public, anon, authenticated;
grant execute on function public.track_email_event_and_stop(uuid, text, text, int)
  to service_role;

-- ---------------------------------------------------------------------------
-- Atomic batch enqueue used by bulk email fan-out. A whole campaign request is
-- either reserved or rejected; request time no longer grows by one insert per
-- recipient, and retries revive terminal failed reservations safely.
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_job_batch(p_jobs jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job jsonb;
  v_id uuid;
  v_status text;
  v_queued int := 0;
  v_duplicates int := 0;
  v_retried int := 0;
begin
  if jsonb_typeof(p_jobs) <> 'array'
     or jsonb_array_length(p_jobs) < 1
     or jsonb_array_length(p_jobs) > 500 then
    raise exception 'Batch must contain 1 to 500 jobs';
  end if;

  for v_job in select value from jsonb_array_elements(p_jobs)
  loop
    -- PL/pgSQL variables retain their previous iteration's value. Clear these
    -- before INSERT .. RETURNING so a conflict cannot be mistaken for a fresh
    -- insert because v_id still contains the prior job id.
    v_id := null;
    v_status := null;

    if nullif(v_job->>'kind', '') is null
       or nullif(v_job->>'dedupe_key', '') is null
       or jsonb_typeof(v_job->'payload') <> 'object' then
      raise exception 'Every batch job needs kind, dedupe_key, and an object payload';
    end if;

    insert into public.job_queue (kind, payload, dedupe_key, max_attempts)
    values (
      v_job->>'kind',
      v_job->'payload',
      v_job->>'dedupe_key',
      greatest(1, least(coalesce((v_job->>'max_attempts')::int, 5), 20))
    )
    on conflict (dedupe_key) do nothing
    returning id into v_id;

    if v_id is not null then
      v_queued := v_queued + 1;
      continue;
    end if;

    select id, status into v_id, v_status
    from public.job_queue
    where dedupe_key = v_job->>'dedupe_key'
    for update;

    -- A retention/delete transaction can remove the conflicting row between
    -- the INSERT conflict and this lookup. Abort the whole batch rather than
    -- report a phantom duplicate and silently omit one recipient; the caller's
    -- idempotency key makes retrying safe.
    if v_id is null then
      raise exception 'Job reservation changed concurrently; retry the batch';
    end if;

    if v_status = 'failed' then
      update public.job_queue
      set status = 'pending',
          attempt_count = 0,
          available_at = now(),
          locked_at = null,
          locked_by = null,
          last_error = null,
          completed_at = null,
          updated_at = now()
      where id = v_id and status = 'failed';
      v_queued := v_queued + 1;
      v_retried := v_retried + 1;
    else
      v_duplicates := v_duplicates + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'queued', v_queued,
    'duplicates', v_duplicates,
    'retried', v_retried
  );
end;
$$;

revoke all on function public.enqueue_job_batch(jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_job_batch(jsonb) to service_role;

-- Replace a sequence and all of its inline steps as one transaction. The old
-- browser flow updated the sequence, deleted every step, and then inserted the
-- replacements in separate requests; an insert failure left an active sequence
-- permanently empty.
create or replace function public.save_email_sequence(
  p_sequence_id uuid,
  p_name text,
  p_list_id uuid,
  p_send_account_id uuid,
  p_active boolean,
  p_start_trigger text,
  p_start_status_ids uuid[],
  p_stop_on text[],
  p_stop_status_ids uuid[],
  p_steps jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sequence_id uuid;
  v_step jsonb;
  v_order bigint;
begin
  if nullif(btrim(p_name), '') is null then
    raise exception 'Sequence name is required';
  end if;
  if p_start_trigger not in ('manual', 'list_added', 'status_change') then
    raise exception 'Invalid sequence start trigger';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_stop_on, '{}'::text[])) value
    where value not in ('open', 'click', 'reply', 'bounce', 'status_change')
  ) then
    raise exception 'Invalid sequence stop trigger';
  end if;
  if p_steps is null
     or jsonb_typeof(p_steps) <> 'array'
     or jsonb_array_length(p_steps) > 100 then
    raise exception 'Sequence steps must be an array with at most 100 entries';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_steps) step
    where nullif(btrim(step->>'subject'), '') is null
       or length(coalesce(step->>'html', '')) > 250000
       or coalesce(step->>'delay_days', '') !~ '^[0-9]{1,4}$'
       or (step->>'delay_days')::int > 3650
  ) then
    raise exception 'Every sequence step needs a subject, bounded HTML, and a delay from 0 to 3650 days';
  end if;

  if p_sequence_id is null then
    insert into public.email_sequences (
      name, list_id, send_account_id, active, start_trigger,
      start_status_ids, stop_on, stop_status_ids
    ) values (
      left(btrim(p_name), 200), p_list_id, p_send_account_id, coalesce(p_active, false),
      p_start_trigger, coalesce(p_start_status_ids, '{}'::uuid[]),
      coalesce(p_stop_on, '{}'::text[]), coalesce(p_stop_status_ids, '{}'::uuid[])
    ) returning id into v_sequence_id;
  else
    update public.email_sequences
    set name = left(btrim(p_name), 200),
        list_id = p_list_id,
        send_account_id = p_send_account_id,
        active = coalesce(p_active, false),
        start_trigger = p_start_trigger,
        start_status_ids = coalesce(p_start_status_ids, '{}'::uuid[]),
        stop_on = coalesce(p_stop_on, '{}'::text[]),
        stop_status_ids = coalesce(p_stop_status_ids, '{}'::uuid[])
    where id = p_sequence_id
    returning id into v_sequence_id;
    if v_sequence_id is null then raise exception 'Sequence not found'; end if;
    delete from public.sequence_steps where sequence_id = v_sequence_id;
  end if;

  for v_step, v_order in
    select value, ordinality
    from jsonb_array_elements(p_steps) with ordinality
  loop
    insert into public.sequence_steps (
      sequence_id, step_order, template_id, subject, html, delay_days
    ) values (
      v_sequence_id,
      v_order,
      null,
      left(btrim(v_step->>'subject'), 500),
      coalesce(v_step->>'html', ''),
      (v_step->>'delay_days')::int
    );
  end loop;

  return v_sequence_id;
end;
$$;

revoke all on function public.save_email_sequence(
  uuid, text, uuid, uuid, boolean, text, uuid[], text[], uuid[], jsonb
) from public, anon, authenticated;
grant execute on function public.save_email_sequence(
  uuid, text, uuid, uuid, boolean, text, uuid[], text[], uuid[], jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- Inline email asset lifecycle. Only the service-role upload route writes this
-- registry. Unreferenced abandoned uploads can be removed after a grace period;
-- assets that were used by a template or delivery are retained so old mail does
-- not break.
-- ---------------------------------------------------------------------------

create table if not exists public.email_assets (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null unique,
  public_url text not null unique,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 5242880),
  mime_type text not null,
  uploaded_by uuid references public.profiles(id) on delete set null,
  referenced_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists email_assets_unreferenced_idx
  on public.email_assets (created_at)
  where referenced_at is null;

alter table public.email_assets enable row level security;
drop policy if exists "email assets admin select" on public.email_assets;
create policy "email assets admin select" on public.email_assets for select
  using (public.is_admin());

create or replace function public.email_asset_unreferenced_bytes()
returns bigint
language sql
security definer
set search_path = public
as $$
  select coalesce(sum(size_bytes), 0)::bigint
  from public.email_assets
  where referenced_at is null;
$$;
revoke all on function public.email_asset_unreferenced_bytes()
  from public, anon, authenticated;
grant execute on function public.email_asset_unreferenced_bytes() to service_role;

-- ---------------------------------------------------------------------------
-- Complete contact erasure for notification jobs. Older jobs do not carry a
-- contactId, so match their notificationId while the referenced log row still
-- exists in this BEFORE DELETE trigger. New jobs carry contactId as well.
-- ---------------------------------------------------------------------------

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
        or j.payload ->> 'notificationId' in (
          select n.id::text from public.notifications_log n where n.contact_id = old.id
        )
      )
  ) then
    raise exception 'Contact has background work in progress; retry when it finishes';
  end if;

  delete from public.job_queue j
  where j.status <> 'processing'
    and (
      lower(j.payload ->> 'contactId') = old.id::text
      or old.deep_search_job_id = j.id
      or j.payload ->> 'notificationId' in (
        select n.id::text from public.notifications_log n where n.contact_id = old.id
      )
    );

  if exists (
    select 1
    from public.job_queue j
    where j.status = 'processing'
      and (
        lower(j.payload ->> 'contactId') = old.id::text
        or old.deep_search_job_id = j.id
        or j.payload ->> 'notificationId' in (
          select n.id::text from public.notifications_log n where n.contact_id = old.id
        )
      )
  ) then
    raise exception 'Contact acquired background work during deletion; retry when it finishes';
  end if;

  update public.import_chunks
  set contact_ids = array_remove(contact_ids, old.id)
  where contact_ids @> array[old.id];

  return old;
end;
$$;

-- A single, queryable schema marker lets application health checks distinguish
-- "feature failed" from "the matching migration was never deployed".
create table if not exists public.app_schema_state (
  singleton boolean primary key default true check (singleton),
  version int not null,
  updated_at timestamptz not null default now()
);
alter table public.app_schema_state enable row level security;
revoke all on table public.app_schema_state from public, anon, authenticated;
insert into public.app_schema_state (singleton, version, updated_at)
values (true, 54, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;
