-- Hardening for the automated link re-check (0038), addressing four audit
-- findings:
--   #3  claim + enqueue are now ONE transaction. The old flow stamped
--       last_checked_at for a whole batch, then enqueued jobs one-by-one in
--       Node; a failure partway through left links stamped-as-checked with no
--       job ever created, so they went unrechecked for another 6-12h. The job
--       rows are now inserted inside claim_due_link_rechecks itself, so a failed
--       insert rolls back the stamp.
--   #5  claim_due_link_rechecks caps how many link_recheck jobs may be in flight
--       (pending or processing) so a large first scan can't enqueue faster than
--       the single heavy lane drains and delay newly-submitted deep searches.
--   #6  record_link_recheck takes the URL that was actually probed and only
--       applies the result if the row still holds that URL (compare-and-set), so
--       an edit mid-fetch can't fold an old URL's result into the new URL.
--   #7  confirm_/dismiss_link_removal require removal_detected = true, so only a
--       genuine 3-strike candidate can be confirmed/dismissed — not any
--       requested link an admin (or a compromised admin session) names directly.

-- ── #3 + #5 ──────────────────────────────────────────────────────────────────
-- Signature gains p_max_inflight, so drop the old two-arg version first to avoid
-- an overload ambiguity when called with defaults.
drop function if exists public.claim_due_link_rechecks(int, int);

create or replace function public.claim_due_link_rechecks(
  p_limit int default 10,
  p_interval_hours int default 8,
  p_max_inflight int default 20
)
returns table (id uuid, contact_id uuid, url text, contact_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_interval int := greatest(least(p_interval_hours, 12), 6);
  v_inflight int;
  v_capacity int;
  -- Hour bucket keeps the dedupe key stable within a tick but distinct across
  -- cycles (claim cadence is >= 6h, so a completed job never blocks the next).
  v_bucket text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24');
begin
  -- #5: how many recheck jobs are already waiting or running. Only claim up to
  -- the remaining headroom so rechecks can't outpace the one-per-tick heavy lane.
  select count(*) into v_inflight
  from public.job_queue
  where kind = 'link_recheck' and status in ('pending', 'processing');
  v_capacity := least(greatest(p_limit, 0), greatest(p_max_inflight - v_inflight, 0));
  if v_capacity <= 0 then
    return; -- queue already saturated with rechecks; try again next tick
  end if;

  return query
  with due as (
    select l.id
    from public.contact_links l
    join public.contacts c on c.id = l.contact_id
    join public.statuses s on s.id = c.status_id
    where l.status = 'requested'
      and l.removal_detected = false
      and s.is_client_status = true
      and nullif(btrim(l.url), '') is not null
      and (
        l.last_checked_at is null
        or l.last_checked_at < now() - make_interval(hours => v_interval)
      )
    order by l.last_checked_at asc nulls first
    for update of l skip locked
    limit v_capacity
  ),
  claimed as (
    update public.contact_links l
    set last_checked_at = now()
    from due
    where l.id = due.id
    returning l.id, l.contact_id, l.url
  ),
  -- #3: enqueue in the SAME statement/transaction as the claim. If this insert
  -- errors the whole thing rolls back, including the last_checked_at stamp, so
  -- the links stay due instead of being marked checked with no job behind them.
  -- (A data-modifying CTE always runs to completion even when the final SELECT
  -- does not read it.)
  enqueued as (
    insert into public.job_queue (kind, payload, dedupe_key, max_attempts)
    select
      'link_recheck',
      jsonb_build_object('linkId', cl.id, 'contactId', cl.contact_id, 'url', cl.url),
      'link-recheck:' || cl.id::text || ':' || v_bucket,
      3
    from claimed cl
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select cl.id, cl.contact_id, cl.url, c.name
  from claimed cl
  join public.contacts c on c.id = cl.contact_id;
end;
$$;

revoke all on function public.claim_due_link_rechecks(int, int, int) from public, anon, authenticated;
grant execute on function public.claim_due_link_rechecks(int, int, int) to service_role;

-- ── #6 ───────────────────────────────────────────────────────────────────────
-- Gains p_expected_url; drop the old three-arg version first.
drop function if exists public.record_link_recheck(uuid, text, int);

create or replace function public.record_link_recheck(
  p_link_id uuid,
  p_result text,
  p_expected_url text,
  p_threshold int default 3
)
-- OUT names deliberately differ from the columns (detected/streak vs
-- removal_detected/gone_streak) so "gone_streak = gone_streak + 1" below is
-- unambiguously the column, not a null OUT variable.
returns table (detected boolean, streak int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_streak int;
  v_detected boolean;
begin
  -- #6: every branch also requires url = p_expected_url. If the operator edited
  -- the URL while the fetch was running, no row matches and the stale result is
  -- discarded (returns detected=false, streak=0) rather than landing on the new
  -- URL's streak.
  if p_result = 'gone' then
    update public.contact_links
      set gone_streak = gone_streak + 1,
          removal_detected = (gone_streak + 1 >= greatest(p_threshold, 1)),
          last_checked_at = now(),
          updated_at = now()
      where id = p_link_id and status = 'requested' and removal_detected = false
        and url = p_expected_url
      returning gone_streak, removal_detected into v_streak, v_detected;
  elsif p_result = 'live' then
    update public.contact_links
      set gone_streak = 0,
          removal_detected = false,
          last_checked_at = now(),
          updated_at = now()
      where id = p_link_id and status = 'requested' and removal_detected = false
        and url = p_expected_url
      returning gone_streak, removal_detected into v_streak, v_detected;
  else
    -- unknown / blocked: do not touch the streak, just record the attempt.
    update public.contact_links
      set last_checked_at = now()
      where id = p_link_id and status = 'requested' and removal_detected = false
        and url = p_expected_url
      returning gone_streak, removal_detected into v_streak, v_detected;
  end if;
  return query select coalesce(v_detected, false), coalesce(v_streak, 0);
end;
$$;

revoke all on function public.record_link_recheck(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.record_link_recheck(uuid, text, text, int) to service_role;

-- ── #7 ───────────────────────────────────────────────────────────────────────
-- Admin confirms a DETECTED removal: flip requested -> removed and fire the same
-- link_status_change side-effect a manual edit would. Now requires
-- removal_detected = true so only a real 3-strike candidate can be confirmed.
create or replace function public.confirm_link_removal(p_link_id uuid, p_actor_id uuid)
returns public.contact_links
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.contact_links%rowtype;
begin
  update public.contact_links
    set status = 'removed', removal_detected = false, gone_streak = 0, updated_at = now()
    where id = p_link_id and status = 'requested' and removal_detected = true
    returning * into v_link;
  if not found then raise exception 'Link is not a confirmed removal candidate'; end if;

  insert into public.job_queue (kind, payload, dedupe_key)
  values (
    'contact_side_effects',
    jsonb_build_object(
      'event', 'link_status_change',
      'contactId', v_link.contact_id,
      'actorId', p_actor_id,
      'link', v_link.url,
      'linkStatus', 'removed'
    ),
    'contact-link-status:' || v_link.contact_id::text || ':' || v_link.position::text || ':' ||
      gen_random_uuid()::text
  );
  insert into public.activity_log (contact_id, actor_id, type, description)
  values (v_link.contact_id, p_actor_id, 'link_change',
    'Removal confirmed for ' || left(v_link.url, 300));
  return v_link;
end;
$$;

revoke all on function public.confirm_link_removal(uuid, uuid) from public, anon, authenticated;
grant execute on function public.confirm_link_removal(uuid, uuid) to service_role;

-- Admin dismisses a false positive: keep it 'requested', clear the streak, re-arm
-- the cadence. Also requires removal_detected = true — you can only dismiss a
-- link the scan actually flagged.
create or replace function public.dismiss_link_removal(p_link_id uuid, p_actor_id uuid)
returns public.contact_links
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.contact_links%rowtype;
begin
  update public.contact_links
    set removal_detected = false, gone_streak = 0, last_checked_at = now(), updated_at = now()
    where id = p_link_id and status = 'requested' and removal_detected = true
    returning * into v_link;
  if not found then raise exception 'Link is not a confirmed removal candidate'; end if;

  insert into public.activity_log (contact_id, actor_id, type, description)
  values (v_link.contact_id, p_actor_id, 'link_change',
    'Removal dismissed — link still up: ' || left(v_link.url, 300));
  return v_link;
end;
$$;

revoke all on function public.dismiss_link_removal(uuid, uuid) from public, anon, authenticated;
grant execute on function public.dismiss_link_removal(uuid, uuid) to service_role;
