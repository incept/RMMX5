-- ============================================================================
-- RMMX5 — transactional intake, protected ownership, bounded tracking/growth
-- Run after 0023_contact_enrichment_job.sql.
-- ============================================================================

-- The oldest active administrator is the installation owner. Promote that
-- account once, then protect the role at the database layer so even a service
-- role API bug cannot demote, disable, or delete it.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('super_admin', 'admin', 'worker'));

with owner as (
  select id
  from public.profiles
  where role = 'admin' and status = 'active'
  order by created_at, id
  limit 1
)
update public.profiles p
set role = 'super_admin'
from owner
where p.id = owner.id
  and not exists (select 1 from public.profiles where role = 'super_admin');

create or replace function public.is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('admin', 'super_admin')
      and status = 'active'
  );
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'super_admin' and status = 'active'
  );
$$;

create or replace function public.protect_admin_ownership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_other_admins int;
begin
  perform pg_advisory_xact_lock(hashtext('rmmx:admin-ownership'));

  if old.role = 'super_admin' then
    if tg_op = 'DELETE' then
      raise exception using
        errcode = '42501',
        message = 'The primary super administrator cannot be deleted, demoted, or disabled';
    elsif new.role is distinct from 'super_admin'
       or new.status is distinct from 'active' then
      raise exception using
        errcode = '42501',
        message = 'The primary super administrator cannot be deleted, demoted, or disabled';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if new.role = 'super_admin'
       and old.role <> 'super_admin'
       and auth.uid() is not null
       and not public.is_super_admin() then
      raise exception using errcode = '42501', message = 'Only a super administrator can assign that role';
    end if;
  end if;

  if old.role in ('admin', 'super_admin') and old.status = 'active' then
    if tg_op = 'DELETE' then
      select count(*) into v_other_admins
      from public.profiles
      where id <> old.id
        and role in ('admin', 'super_admin')
        and status = 'active';
      if v_other_admins = 0 then
        raise exception using errcode = '42501', message = 'At least one active administrator is required';
      end if;
    elsif new.role not in ('admin', 'super_admin') or new.status <> 'active' then
      select count(*) into v_other_admins
      from public.profiles
      where id <> old.id
        and role in ('admin', 'super_admin')
        and status = 'active';
      if v_other_admins = 0 then
        raise exception using errcode = '42501', message = 'At least one active administrator is required';
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists protect_admin_ownership on public.profiles;
create trigger protect_admin_ownership
  before update or delete on public.profiles
  for each row execute function public.protect_admin_ownership();

-- Queue kinds used by transactional intake/import completion.
alter table public.job_queue drop constraint if exists job_queue_kind_check;
alter table public.job_queue
  add constraint job_queue_kind_check check (
    kind in (
      'auto_search', 'deep_search', 'contact_enrichment', 'score_contact',
      'email_delivery', 'sms_delivery', 'voicemail_delivery',
      'notification_delivery'
    )
  );

-- Complete a call and persist every required follow-up job in the same commit.
create or replace function public.complete_call_processing(
  p_call_row_id uuid,
  p_call_id text,
  p_contact_id uuid,
  p_enqueue_enrichment boolean,
  p_enqueue_search boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.calls
  set contact_id = p_contact_id,
      processing_status = 'completed',
      locked_at = null,
      last_error = null,
      processed_at = now()
  where id = p_call_row_id and processing_status = 'processing';
  if not found then
    raise exception 'Call processing lease was lost';
  end if;

  if p_enqueue_enrichment then
    insert into public.job_queue (kind, payload, dedupe_key)
    values (
      'contact_enrichment',
      jsonb_build_object('contactId', p_contact_id),
      'enrich:callscaler:' || p_call_id
    )
    on conflict (dedupe_key) do nothing;
  end if;

  if p_enqueue_search then
    insert into public.job_queue (kind, payload, dedupe_key)
    values (
      'auto_search',
      jsonb_build_object('contactId', p_contact_id),
      'auto-search:callscaler:' || p_call_id
    )
    on conflict (dedupe_key) do nothing;
  end if;
end;
$$;
revoke all on function public.complete_call_processing(uuid, text, uuid, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.complete_call_processing(uuid, text, uuid, boolean, boolean)
  to service_role;

-- Fluent Forms contact creation, receipt detail, and search job are one atomic
-- operation. A retry returns the original contact instead of creating another.
alter table public.webhook_leads add column if not exists provider text;
alter table public.webhook_leads add column if not exists event_id text;
create unique index if not exists webhook_leads_provider_event_idx
  on public.webhook_leads (provider, event_id)
  where provider is not null and event_id is not null;

create or replace function public.create_fluent_lead(
  p_event_id text,
  p_payload jsonb,
  p_contact jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact_id uuid;
  v_status_id uuid;
begin
  select contact_id into v_contact_id
  from public.webhook_leads
  where provider = 'fluent_forms' and event_id = left(p_event_id, 500);
  if v_contact_id is not null then return v_contact_id; end if;

  select id into v_status_id from public.statuses where name = 'New' limit 1;
  insert into public.contacts (
    name, email, phone, city, state, status_id, browser, ip, device,
    source_url, wp_user, submitted_at, source, utm, ppc_kw, gclid
  )
  values (
    coalesce(nullif(p_contact->>'name', ''), '(no name)'),
    nullif(p_contact->>'email', ''),
    nullif(p_contact->>'phone', ''),
    nullif(p_contact->>'city', ''),
    nullif(p_contact->>'state', ''),
    v_status_id,
    nullif(p_contact->>'browser', ''),
    nullif(p_contact->>'ip', ''),
    nullif(p_contact->>'device', ''),
    nullif(p_contact->>'source_url', ''),
    nullif(p_contact->>'wp_user', ''),
    case when nullif(p_contact->>'submitted_at', '') is null
      then null else (p_contact->>'submitted_at')::timestamptz end,
    coalesce(nullif(p_contact->>'source', ''), 'fluent_forms'),
    nullif(p_contact->>'utm', ''),
    nullif(p_contact->>'ppc_kw', ''),
    nullif(p_contact->>'gclid', '')
  )
  returning id into v_contact_id;

  insert into public.webhook_leads (
    provider, event_id, payload, contact_id, status
  )
  values ('fluent_forms', left(p_event_id, 500), p_payload, v_contact_id, 'processed');

  insert into public.job_queue (kind, payload, dedupe_key)
  values (
    'auto_search',
    jsonb_build_object('contactId', v_contact_id),
    'auto-search:fluent-forms:' || left(p_event_id, 500)
  )
  on conflict (dedupe_key) do nothing;

  return v_contact_id;
end;
$$;
revoke all on function public.create_fluent_lead(text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_fluent_lead(text, jsonb, jsonb) to service_role;

-- Import each chunk and all its links transactionally. The chunk key makes a
-- client retry return the original IDs.
create table if not exists public.import_chunks (
  request_key text primary key,
  contact_ids uuid[] not null default '{}',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.import_chunks enable row level security;
revoke all on public.import_chunks from anon, authenticated;
grant select, insert on public.import_chunks to service_role;

create or replace function public.import_contact_chunk(
  p_request_key text,
  p_rows jsonb,
  p_created_by uuid
)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing uuid[];
  v_ids uuid[] := '{}';
  v_row jsonb;
  v_contact_id uuid;
  v_link jsonb;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 100 then
    raise exception 'Import chunks must contain 1 to 100 rows';
  end if;
  select contact_ids into v_existing
  from public.import_chunks where request_key = p_request_key;
  if v_existing is not null then return v_existing; end if;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    insert into public.contacts (
      name, email, phone, city, state, status_id, browser, ppc_kw, source, ip, utm
    )
    values (
      coalesce(nullif(v_row->>'name', ''), '(no name)'),
      nullif(v_row->>'email', ''),
      nullif(v_row->>'phone', ''),
      nullif(v_row->>'city', ''),
      nullif(v_row->>'state', ''),
      nullif(v_row->>'status_id', '')::uuid,
      nullif(v_row->>'browser', ''),
      nullif(v_row->>'ppc_kw', ''),
      coalesce(nullif(v_row->>'source', ''), 'import'),
      nullif(v_row->>'ip', ''),
      nullif(v_row->>'utm', '')
    )
    returning id into v_contact_id;
    v_ids := array_append(v_ids, v_contact_id);

    for v_link in select value from jsonb_array_elements(coalesce(v_row->'links', '[]'::jsonb))
    loop
      insert into public.contact_links (contact_id, position, url, status)
      values (
        v_contact_id,
        (v_link->>'position')::int,
        v_link->>'url',
        coalesce(nullif(v_link->>'status', ''), 'live')
      );
    end loop;

    insert into public.job_queue (kind, payload, dedupe_key)
    values (
      'score_contact',
      jsonb_build_object('contactId', v_contact_id),
      'score:import:' || v_contact_id::text
    )
    on conflict (dedupe_key) do nothing;
  end loop;

  insert into public.import_chunks (request_key, contact_ids, created_by)
  values (p_request_key, v_ids, p_created_by);
  return v_ids;
end;
$$;
revoke all on function public.import_contact_chunk(text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.import_contact_chunk(text, jsonb, uuid) to service_role;

alter table public.imports add column if not exists request_key text;
create unique index if not exists imports_request_key_idx
  on public.imports(request_key) where request_key is not null;

-- File quotas and a recoverable delete state.
alter table public.contact_files add column if not exists status text not null default 'active';
alter table public.contact_files drop constraint if exists contact_files_status_check;
alter table public.contact_files
  add constraint contact_files_status_check check (status in ('active', 'deleting'));
create index if not exists contact_files_created_idx on public.contact_files(created_at);

create or replace function public.enforce_contact_file_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count bigint;
  v_bytes bigint;
begin
  perform 1 from public.contacts where id = new.contact_id for update;
  select count(*), coalesce(sum(size_bytes), 0)
  into v_count, v_bytes
  from public.contact_files
  where contact_id = new.contact_id and status = 'active';
  if v_count >= 50 then raise exception 'Contact file limit (50) reached'; end if;
  if v_bytes + new.size_bytes > 104857600 then
    raise exception 'Contact storage quota (100 MB) reached';
  end if;
  return new;
end;
$$;
drop trigger if exists enforce_contact_file_quota on public.contact_files;
create trigger enforce_contact_file_quota
  before insert on public.contact_files
  for each row execute function public.enforce_contact_file_quota();

create or replace function public.contact_file_usage(p_contact_id uuid)
returns table (file_count bigint, total_bytes bigint)
language sql
security definer
set search_path = public
as $$
  select count(*), coalesce(sum(size_bytes), 0)::bigint
  from public.contact_files
  where contact_id = p_contact_id and status = 'active';
$$;
revoke all on function public.contact_file_usage(uuid) from public, anon, authenticated;
grant execute on function public.contact_file_usage(uuid) to service_role;

create or replace function public.marketing_list_counts()
returns table (list_id uuid, member_count bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active() then raise exception 'not authorized'; end if;
  return query
    select l.id, count(m.id)
    from public.email_lists l
    left join public.email_list_members m on m.list_id = l.id
    group by l.id;
end;
$$;
revoke all on function public.marketing_list_counts() from public, anon;
grant execute on function public.marketing_list_counts() to authenticated;

create or replace function public.marketing_sequence_counts()
returns table (sequence_id uuid, enrollment_count bigint, active_count bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active() then raise exception 'not authorized'; end if;
  return query
    select s.id, count(e.id), count(e.id) filter (where e.status = 'active')
    from public.email_sequences s
    left join public.sequence_enrollments e on e.sequence_id = s.id
    group by s.id;
end;
$$;
revoke all on function public.marketing_sequence_counts() from public, anon;
grant execute on function public.marketing_sequence_counts() to authenticated;

create or replace function public.revenue_projection_total()
returns numeric
language sql
security definer
set search_path = public
as $$
  select coalesce(sum(revenue_projection), 0) from public.contacts;
$$;
revoke all on function public.revenue_projection_total() from public, anon, authenticated;
grant execute on function public.revenue_projection_total() to service_role;

-- One persistent bucket per event/message/URL. This replaces per-process-only
-- throttling and makes the counter and event insert a single atomic operation.
create table if not exists public.email_event_buckets (
  message_id uuid not null references public.email_messages(id) on delete cascade,
  event_type text not null check (event_type in ('open', 'click')),
  url_hash text not null default '',
  bucket_started timestamptz not null,
  primary key (message_id, event_type, url_hash, bucket_started)
);
alter table public.email_event_buckets enable row level security;
revoke all on public.email_event_buckets from anon, authenticated;
grant select, insert, delete on public.email_event_buckets to service_role;

create or replace function public.track_email_event_bounded(
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
  v_contact_id uuid;
  v_rows int := 0;
  v_bucket timestamptz;
  v_hash text := '';
begin
  if p_event not in ('open', 'click') then raise exception 'invalid event'; end if;
  p_bucket_seconds := greatest(10, least(coalesce(p_bucket_seconds, 60), 3600));
  v_bucket := to_timestamp(
    floor(extract(epoch from now()) / p_bucket_seconds) * p_bucket_seconds
  );
  if p_url is not null then v_hash := md5(p_url); end if;

  insert into public.email_event_buckets(message_id, event_type, url_hash, bucket_started)
  values (p_message_id, p_event, v_hash, v_bucket)
  on conflict do nothing;
  get diagnostics v_rows = row_count;

  select em.contact_id into v_contact_id
  from public.email_messages em where em.id = p_message_id;
  if not found then return; end if;

  if v_rows = 1 then
    update public.email_messages
    set open_count = open_count + case when p_event = 'open' then 1 else 0 end,
        click_count = click_count + case when p_event = 'click' then 1 else 0 end
    where id = p_message_id;
    insert into public.email_events(message_id, contact_id, type, url)
    values (p_message_id, v_contact_id, p_event, p_url);
  end if;
  return query select p_message_id, v_contact_id, v_rows = 1;
end;
$$;
revoke all on function public.track_email_event_bounded(uuid, text, text, int)
  from public, anon, authenticated;
grant execute on function public.track_email_event_bounded(uuid, text, text, int)
  to service_role;

create index if not exists email_events_created_idx on public.email_events(created_at);
create index if not exists notifications_log_created_idx on public.notifications_log(created_at);
create index if not exists imports_created_idx on public.imports(created_at);
create index if not exists webhook_leads_created_idx on public.webhook_leads(created_at);
create index if not exists sms_messages_created_idx on public.sms_messages(created_at);
create index if not exists voicemail_sends_created_idx on public.voicemail_sends(created_at);

-- Admin-controlled purge with an allowlist. Contacts and active delivery rows
-- are deliberately excluded. The API requires super-admin confirmation.
create or replace function public.purge_admin_data(
  p_target text,
  p_older_than_days int
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_deleted bigint;
begin
  if p_older_than_days < 1 or p_older_than_days > 3650 then
    raise exception 'Retention interval must be between 1 and 3650 days';
  end if;
  case p_target
    when 'email_events' then
      delete from public.email_events where created_at < now() - make_interval(days => p_older_than_days);
    when 'email_messages' then
      delete from public.email_messages where created_at < now() - make_interval(days => p_older_than_days);
    when 'calls' then
      delete from public.calls where processing_status = 'completed'
        and created_at < now() - make_interval(days => p_older_than_days);
    when 'activity_log' then
      delete from public.activity_log where created_at < now() - make_interval(days => p_older_than_days);
    when 'notifications_log' then
      delete from public.notifications_log where created_at < now() - make_interval(days => p_older_than_days);
    when 'imports' then
      delete from public.imports where created_at < now() - make_interval(days => p_older_than_days);
    when 'search_candidates' then
      delete from public.search_candidates where status in ('rejected', 'confirmed')
        and created_at < now() - make_interval(days => p_older_than_days);
    when 'debug_log' then
      delete from public.debug_log where created_at < now() - make_interval(days => p_older_than_days);
    when 'webhook_leads' then
      delete from public.webhook_leads where created_at < now() - make_interval(days => p_older_than_days);
    when 'sms_messages' then
      delete from public.sms_messages where created_at < now() - make_interval(days => p_older_than_days);
    when 'voicemail_sends' then
      delete from public.voicemail_sends where created_at < now() - make_interval(days => p_older_than_days);
    when 'job_queue' then
      delete from public.job_queue where status in ('completed', 'failed')
        and updated_at < now() - make_interval(days => p_older_than_days);
    when 'usage_events' then
      delete from public.usage_events where status <> 'attempted'
        and created_at < now() - make_interval(days => p_older_than_days);
    else
      raise exception 'Unsupported purge target';
  end case;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke all on function public.purge_admin_data(text, int) from public, anon, authenticated;
grant execute on function public.purge_admin_data(text, int) to service_role;

-- Conservative automatic bounds. Admins can choose shorter windows manually.
create or replace function public.prune_growth_tables()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_events bigint;
  v_buckets bigint;
  v_raw bigint;
begin
  delete from public.email_events where created_at < now() - interval '25 months';
  get diagnostics v_events = row_count;
  delete from public.email_event_buckets where bucket_started < now() - interval '90 days';
  get diagnostics v_buckets = row_count;
  update public.calls set raw = '{}'::jsonb
  where raw <> '{}'::jsonb and created_at < now() - interval '90 days';
  get diagnostics v_raw = row_count;
  delete from public.import_chunks where created_at < now() - interval '90 days';
  return jsonb_build_object(
    'email_events_deleted', v_events,
    'tracking_buckets_deleted', v_buckets,
    'call_payloads_cleared', v_raw
  );
end;
$$;
revoke all on function public.prune_growth_tables() from public, anon, authenticated;
grant execute on function public.prune_growth_tables() to service_role;
