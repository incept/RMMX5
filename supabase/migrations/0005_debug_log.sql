-- ============================================================================
-- RMMX5 — Debug log
-- Run after 0004_contact_intake_metadata.sql.
--
-- One place to see every failure. Integration errors previously surfaced only
-- as a line in a contact's activity feed (or nowhere at all, when the failure
-- happened outside a contact's context), which made diagnosing a broken key or
-- webhook slow. Written by server code with the service role; readable by
-- admins only, because context can contain request details.
-- ============================================================================

create table if not exists public.debug_log (
  id uuid primary key default gen_random_uuid(),
  level text not null default 'error' check (level in ('error', 'warn', 'info')),
  source text not null,  -- 'brightdata', 'email-send', 'webhook:fluent-forms', …
  message text not null,
  context jsonb not null default '{}'::jsonb,
  contact_id uuid references public.contacts (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists debug_log_created_idx on public.debug_log (created_at desc);
create index if not exists debug_log_level_idx on public.debug_log (level, created_at desc);
create index if not exists debug_log_source_idx on public.debug_log (source, created_at desc);

alter table public.debug_log enable row level security;

drop policy if exists "debug log select" on public.debug_log;
create policy "debug log select" on public.debug_log for select using (public.is_admin());

drop policy if exists "debug log delete" on public.debug_log;
create policy "debug log delete" on public.debug_log for delete using (public.is_admin());

-- Keeps the table from growing without bound; call from the cron tick.
create or replace function public.prune_debug_log(p_keep_days int default 14)
returns int
language sql
security definer set search_path = public
as $$
  with deleted as (
    delete from public.debug_log
    where created_at < now() - make_interval(days => greatest(1, coalesce(p_keep_days, 14)))
    returning 1
  )
  select count(*)::int from deleted;
$$;

revoke all on function public.prune_debug_log(int) from public, anon, authenticated;
grant execute on function public.prune_debug_log(int) to service_role;
