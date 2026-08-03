-- Cross-process send rate gate (finding #9). The Emailit throttle was
-- process-local: several app processes (Hostinger can run more than one) could
-- each send inside the same 1-second window and trip Emailit's 2/sec cap, and a
-- 429 retry could still collide. This shared "next allowed send" clock lets every
-- process serialize against one row, so sends stay spaced >= the interval no
-- matter how many processes are draining the queue.

create table if not exists public.provider_rate_limits (
  provider text primary key,
  last_send_at timestamptz not null default now()
);

alter table public.provider_rate_limits enable row level security;
-- No policies: only service_role (which bypasses RLS) ever touches this table.

-- Atomically reserve the next send slot for a provider and return it. The first
-- call returns ~now(); each subsequent call advances the slot by p_min_interval_ms
-- from the later of {previous slot, now()}. Concurrent callers serialize on the
-- row lock that INSERT ... ON CONFLICT DO UPDATE takes, so each gets a distinct,
-- spaced slot. The caller sleeps until the returned timestamp before sending.
create or replace function public.claim_provider_send_slot(
  p_provider text,
  p_min_interval_ms int
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slot timestamptz;
begin
  insert into public.provider_rate_limits as prl (provider, last_send_at)
    values (p_provider, now())
    on conflict (provider) do update
      set last_send_at = greatest(
        prl.last_send_at + make_interval(secs => greatest(p_min_interval_ms, 0) / 1000.0),
        now()
      )
    returning last_send_at into v_slot;
  return v_slot;
end;
$$;

revoke all on function public.claim_provider_send_slot(text, int) from public, anon, authenticated;
grant execute on function public.claim_provider_send_slot(text, int) to service_role;
