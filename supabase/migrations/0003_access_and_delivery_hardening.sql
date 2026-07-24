-- ============================================================================
-- RMMX5 — Access control and delivery reliability hardening
-- Run after 0002_security.sql.
-- ============================================================================

-- New Auth users must be activated by an existing administrator. This removes
-- both public worker enrollment and the race to become the first administrator.
alter table public.profiles alter column status set default 'disabled';

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role, status)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    'worker',
    'disabled'
  );
  return new;
end;
$$;

-- Workers cannot self-promote, while service-role and SQL-editor operations
-- (whose auth.uid() is null) can perform deliberate provisioning.
create or replace function public.protect_privileged_profile_fields()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    new.role := old.role;
    new.status := old.status;
  end if;
  return new;
end;
$$;

-- SMTP accounts are team senders: active workers may use them, but only an
-- administrator may create, retarget, change credentials, or delete them.
drop policy if exists "email accounts all" on public.email_accounts;
drop policy if exists "email accounts select" on public.email_accounts;
drop policy if exists "email accounts insert" on public.email_accounts;
drop policy if exists "email accounts update" on public.email_accounts;
drop policy if exists "email accounts delete" on public.email_accounts;

create policy "email accounts select" on public.email_accounts for select
  using (public.is_active());
create policy "email accounts insert" on public.email_accounts for insert
  with check (public.is_admin());
create policy "email accounts update" on public.email_accounts for update
  using (public.is_admin())
  with check (public.is_admin());
create policy "email accounts delete" on public.email_accounts for delete
  using (public.is_admin());

-- Sequence workers lease due rows atomically. Failed deliveries retain their
-- current step and can be retried with bounded backoff.
alter table public.sequence_enrollments
  add column if not exists attempt_count int not null default 0,
  add column if not exists last_error text;

create or replace function public.claim_due_sequence_enrollments(p_limit int default 100)
returns table (
  id uuid,
  sequence_id uuid,
  contact_id uuid,
  current_step int,
  attempt_count int
)
language sql
security definer set search_path = public
as $$
  with due as (
    select se.id
    from public.sequence_enrollments se
    where se.status = 'active'
      and se.next_send_at <= now()
    order by se.next_send_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 100), 100))
  ),
  claimed as (
    update public.sequence_enrollments se
    set next_send_at = now() + interval '30 minutes'
    from due
    where se.id = due.id
    returning se.id, se.sequence_id, se.contact_id, se.current_step, se.attempt_count
  )
  select * from claimed;
$$;

revoke all on function public.claim_due_sequence_enrollments(int) from public, anon, authenticated;
grant execute on function public.claim_due_sequence_enrollments(int) to service_role;

-- Explicit delivery keys make countdown notifications independent of template
-- wording and let concurrent cron requests reserve a send only once.
alter table public.notifications_log
  add column if not exists dedupe_key text;
alter table public.notifications_log
  drop constraint if exists notifications_log_status_check;
alter table public.notifications_log
  add constraint notifications_log_status_check
  check (status in ('pending', 'sent', 'failed'));
create unique index if not exists notifications_log_dedupe_idx
  on public.notifications_log (dedupe_key) where dedupe_key is not null;

-- Signed provider retries carry stable event IDs. Only service-role server code
-- can access this RLS-protected receipt table.
create table if not exists public.webhook_receipts (
  provider text not null,
  event_id text not null,
  received_at timestamptz not null default now(),
  primary key (provider, event_id)
);
alter table public.webhook_receipts enable row level security;
revoke all on table public.webhook_receipts from anon, authenticated;
grant select, insert, delete on table public.webhook_receipts to service_role;
