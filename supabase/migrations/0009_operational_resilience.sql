-- ============================================================================
-- RMMX5 — bounded background work, exact usage accounting, and durable retries
-- Run after 0008_hardening.sql.
-- ============================================================================

-- Atomic leases replace settings-table read/then/write locks.
create table if not exists public.app_leases (
  name text primary key,
  holder text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.app_leases enable row level security;
revoke all on public.app_leases from anon, authenticated;
grant select, insert, update, delete on public.app_leases to service_role;

create or replace function public.try_acquire_app_lease(
  p_name text,
  p_holder text,
  p_ttl_seconds int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  if p_ttl_seconds < 10 or p_ttl_seconds > 900 then
    raise exception 'lease ttl must be between 10 and 900 seconds';
  end if;

  insert into public.app_leases (name, holder, expires_at, updated_at)
  values (p_name, p_holder, now() + make_interval(secs => p_ttl_seconds), now())
  on conflict (name) do update
    set holder = excluded.holder,
        expires_at = excluded.expires_at,
        updated_at = now()
  where public.app_leases.expires_at <= now()
     or public.app_leases.holder = excluded.holder;

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke all on function public.try_acquire_app_lease(text, text, int) from public, anon, authenticated;
grant execute on function public.try_acquire_app_lease(text, text, int) to service_role;

-- A small database-backed queue keeps expensive provider calls out of webhook
-- and bulk-request lifetimes. Only the service role can observe or mutate it.
create table if not exists public.job_queue (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (
    kind in ('auto_search', 'email_delivery', 'sms_delivery',
             'voicemail_delivery', 'notification_delivery')
  ),
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed')),
  attempt_count int not null default 0,
  max_attempts int not null default 5 check (max_attempts between 1 and 20),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists job_queue_claim_idx
  on public.job_queue (status, available_at, created_at)
  where status in ('pending', 'processing');

alter table public.job_queue enable row level security;
revoke all on public.job_queue from anon, authenticated;
grant select, insert, update, delete on public.job_queue to service_role;

create or replace function public.claim_jobs(
  p_worker text,
  p_limit int default 2,
  p_lease_seconds int default 150
)
returns setof public.job_queue
language sql
security definer
set search_path = public
as $$
  with exhausted as (
    update public.job_queue
    set status = 'failed',
        locked_at = null,
        locked_by = null,
        last_error = coalesce(last_error, 'Worker lease expired after final attempt'),
        updated_at = now()
    where status = 'processing'
      and attempt_count >= max_attempts
      and locked_at < now() - make_interval(secs => p_lease_seconds)
    returning id
  ),
  claimable as (
    select id
    from public.job_queue
    where attempt_count < max_attempts
      and available_at <= now()
      and (
        status = 'pending'
        or (status = 'processing'
            and locked_at < now() - make_interval(secs => p_lease_seconds))
      )
    order by available_at, created_at
    for update skip locked
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
    and not exists (select 1 from exhausted where exhausted.id = j.id)
  returning j.*;
$$;

revoke all on function public.claim_jobs(text, int, int) from public, anon, authenticated;
grant execute on function public.claim_jobs(text, int, int) to service_role;

-- Exact, append-only provider usage. The reservation function serializes each
-- provider/operation/month and optionally enforces a hard monthly ceiling.
create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  operation text not null,
  request_key text not null unique,
  quantity int not null default 1 check (quantity > 0),
  status text not null default 'attempted'
    check (status in ('attempted', 'succeeded', 'failed')),
  metadata jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists usage_events_month_idx
  on public.usage_events (provider, operation, created_at);

alter table public.usage_events enable row level security;
revoke all on public.usage_events from anon, authenticated;
grant select, insert, update on public.usage_events to service_role;

create or replace function public.reserve_usage_event(
  p_provider text,
  p_operation text,
  p_request_key text,
  p_quantity int default 1,
  p_monthly_limit int default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_used bigint;
  v_month_start timestamptz := date_trunc('month', now());
begin
  perform pg_advisory_xact_lock(hashtext(p_provider || ':' || p_operation || ':' || v_month_start::text));

  select id into v_id
  from public.usage_events
  where request_key = p_request_key;
  if v_id is not null then
    return v_id;
  end if;

  if p_monthly_limit is not null and p_monthly_limit > 0 then
    select coalesce(sum(quantity), 0) into v_used
    from public.usage_events
    where provider = p_provider
      and operation = p_operation
      and created_at >= v_month_start
      and created_at < v_month_start + interval '1 month';
    if v_used + p_quantity > p_monthly_limit then
      raise exception 'monthly usage limit exceeded for %.%', p_provider, p_operation
        using errcode = 'P0001';
    end if;
  end if;

  insert into public.usage_events
    (provider, operation, request_key, quantity, metadata)
  values
    (p_provider, p_operation, p_request_key, p_quantity, coalesce(p_metadata, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.reserve_usage_event(text, text, text, int, int, jsonb)
  from public, anon, authenticated;
grant execute on function public.reserve_usage_event(text, text, text, int, int, jsonb)
  to service_role;

-- Indexed normalized identities avoid scanning thousands of contacts in JS.
alter table public.contacts
  add column if not exists email_normalized text
  generated always as (lower(btrim(email))) stored;
create index if not exists contacts_email_normalized_idx
  on public.contacts (email_normalized)
  where email_normalized is not null;

alter table public.contacts
  add column if not exists phone_normalized text
  generated always as (
    right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)
  ) stored;
create index if not exists contacts_phone_normalized_idx
  on public.contacts (phone_normalized)
  where phone_normalized <> '';

-- A call row is an idempotency record and a recoverable processing state.
alter table public.calls
  add column if not exists processing_status text not null default 'pending',
  add column if not exists attempt_count int not null default 0,
  add column if not exists locked_at timestamptz,
  add column if not exists last_error text,
  add column if not exists processed_at timestamptz;

alter table public.calls drop constraint if exists calls_processing_status_check;
alter table public.calls add constraint calls_processing_status_check
  check (processing_status in ('pending', 'processing', 'completed', 'failed'));

update public.calls
set processing_status = 'completed',
    processed_at = coalesce(processed_at, created_at)
where processing_status = 'pending';

create index if not exists calls_processing_idx
  on public.calls (processing_status, locked_at)
  where processing_status <> 'completed';

create or replace function public.claim_call_processing(
  p_call_id text,
  p_lease_seconds int default 180
)
returns table (id uuid, contact_id uuid)
language sql
security definer
set search_path = public
as $$
  update public.calls c
  set processing_status = 'processing',
      attempt_count = c.attempt_count + 1,
      locked_at = now(),
      last_error = null
  where c.call_id = p_call_id
    and c.attempt_count < 5
    and (
      c.processing_status in ('pending', 'failed')
      or (c.processing_status = 'processing'
          and c.locked_at < now() - make_interval(secs => p_lease_seconds))
    )
  returning c.id, c.contact_id;
$$;

revoke all on function public.claim_call_processing(text, int) from public, anon, authenticated;
grant execute on function public.claim_call_processing(text, int) to service_role;

-- Recipient-level keys make a retried HTTP request or queue claim converge on
-- the original delivery row instead of charging a provider twice.
alter table public.email_messages add column if not exists delivery_key text;
create unique index if not exists email_messages_delivery_key_idx
  on public.email_messages (delivery_key) where delivery_key is not null;

alter table public.sms_campaigns add column if not exists request_key text;
create unique index if not exists sms_campaigns_request_key_idx
  on public.sms_campaigns (request_key) where request_key is not null;

alter table public.sms_messages add column if not exists delivery_key text;
create unique index if not exists sms_messages_delivery_key_idx
  on public.sms_messages (delivery_key) where delivery_key is not null;

alter table public.voicemail_sends add column if not exists delivery_key text;
create unique index if not exists voicemail_sends_delivery_key_idx
  on public.voicemail_sends (delivery_key) where delivery_key is not null;

-- Bound the operational tables without discarding recent troubleshooting or
-- billing history. Called by the cron heartbeat.
create or replace function public.prune_operational_tables()
returns table (jobs_deleted int, leases_deleted int, usage_deleted int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jobs int;
  v_leases int;
  v_usage int;
begin
  delete from public.job_queue
  where (status = 'completed' and completed_at < now() - interval '30 days')
     or (status = 'failed' and updated_at < now() - interval '90 days');
  get diagnostics v_jobs = row_count;

  delete from public.app_leases
  where expires_at < now() - interval '1 day';
  get diagnostics v_leases = row_count;

  delete from public.usage_events
  where created_at < now() - interval '25 months';
  get diagnostics v_usage = row_count;

  return query select v_jobs, v_leases, v_usage;
end;
$$;

revoke all on function public.prune_operational_tables() from public, anon, authenticated;
grant execute on function public.prune_operational_tables() to service_role;
