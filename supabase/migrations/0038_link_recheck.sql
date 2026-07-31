-- Automated link re-checking for CLIENT contacts. Once a removal link is marked
-- 'requested', a scan re-fetches it every 6-12h; after 3 consecutive "gone"
-- reads it is surfaced (removal_detected) for an admin to confirm with one click
-- — it is never auto-flipped, and a transient block never counts as "gone".

alter table public.contact_links
  add column if not exists last_checked_at timestamptz,
  add column if not exists gone_streak smallint not null default 0,
  add column if not exists removal_detected boolean not null default false;

comment on column public.contact_links.gone_streak is
  'Consecutive re-check reads where the record appears gone; reset to 0 by any live read. 3 in a row raises removal_detected.';
comment on column public.contact_links.removal_detected is
  'A requested link that read gone enough times to await admin confirmation. Not a status — the operator confirms the flip to removed.';

-- Due-link lookups: only open requested candidates, oldest check first.
create index if not exists contact_links_recheck_idx
  on public.contact_links (last_checked_at)
  where status = 'requested' and removal_detected = false;

-- Register the heavy re-check job kind.
alter table public.job_queue drop constraint if exists job_queue_kind_check;
alter table public.job_queue
  add constraint job_queue_kind_check check (
    kind in (
      'auto_search', 'deep_search', 'contact_enrichment', 'score_contact',
      'email_delivery', 'sms_delivery', 'voicemail_delivery',
      'notification_delivery', 'contact_side_effects', 'link_recheck'
    )
  );

-- Keep link_recheck OFF the light lane: its fetch can spawn Chrome/unlocker and
-- run for seconds, which must never sit in the same sequential batch as email /
-- SMS deliveries. Excluded here, it is claimed by claim_jobs (the heavy lane),
-- one at a time alongside the searches. (Body copied from 0036 + link_recheck.)
create or replace function public.claim_light_jobs(
  p_worker text,
  p_limit int default 20,
  p_lease_seconds int default 150
)
returns setof public.job_queue
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimable as (
    select
      j.id,
      case j.kind
        when 'email_delivery' then 0
        when 'sms_delivery' then 0
        when 'voicemail_delivery' then 0
        when 'notification_delivery' then 0
        when 'contact_enrichment' then 5
        when 'contact_side_effects' then 5
        when 'score_contact' then 9
        else 5
      end as prio
    from public.job_queue j
    where j.kind not in ('deep_search', 'auto_search', 'link_recheck')
      and j.attempt_count < j.max_attempts
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
    order by prio, j.available_at, j.created_at
    for update of j skip locked
    limit least(greatest(p_limit, 1), 100)
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

revoke all on function public.claim_light_jobs(text, int, int) from public, anon, authenticated;
grant execute on function public.claim_light_jobs(text, int, int) to service_role;

-- Atomically claim a batch of due client links and stamp last_checked_at now, so
-- a link is enqueued at most once per interval and concurrent ticks never
-- double-claim (skip locked). Interval clamped to the 6-12h window.
create or replace function public.claim_due_link_rechecks(
  p_limit int default 10,
  p_interval_hours int default 8
)
returns table (id uuid, contact_id uuid, url text, contact_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_interval int := greatest(least(p_interval_hours, 12), 6);
begin
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
    limit least(greatest(p_limit, 1), 100)
  )
  update public.contact_links l
  set last_checked_at = now()
  from due, public.contacts c
  where l.id = due.id and c.id = l.contact_id
  returning l.id, l.contact_id, l.url, c.name;
end;
$$;

revoke all on function public.claim_due_link_rechecks(int, int) from public, anon, authenticated;
grant execute on function public.claim_due_link_rechecks(int, int) to service_role;

-- Fold one re-check result into the link. 'gone' advances the streak (and raises
-- removal_detected at the threshold); 'live' clears it; 'unknown' (a block or
-- error) only touches last_checked_at so a bad hour can never mark a link gone.
create or replace function public.record_link_recheck(
  p_link_id uuid,
  p_result text,
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
  if p_result = 'gone' then
    update public.contact_links
      set gone_streak = gone_streak + 1,
          removal_detected = (gone_streak + 1 >= greatest(p_threshold, 1)),
          last_checked_at = now(),
          updated_at = now()
      where id = p_link_id and status = 'requested' and removal_detected = false
      returning gone_streak, removal_detected into v_streak, v_detected;
  elsif p_result = 'live' then
    update public.contact_links
      set gone_streak = 0,
          removal_detected = false,
          last_checked_at = now(),
          updated_at = now()
      where id = p_link_id and status = 'requested' and removal_detected = false
      returning gone_streak, removal_detected into v_streak, v_detected;
  else
    -- unknown / blocked: do not touch the streak, just record the attempt.
    update public.contact_links
      set last_checked_at = now()
      where id = p_link_id and status = 'requested' and removal_detected = false
      returning gone_streak, removal_detected into v_streak, v_detected;
  end if;
  return query select coalesce(v_detected, false), coalesce(v_streak, 0);
end;
$$;

revoke all on function public.record_link_recheck(uuid, text, int) from public, anon, authenticated;
grant execute on function public.record_link_recheck(uuid, text, int) to service_role;

-- Admin confirms a detected removal: flip requested -> removed, clear detection,
-- and fire the SAME link_status_change side-effect a manual edit would (which
-- runs the client "your link is now removed" notification).
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
    where id = p_link_id and status = 'requested'
    returning * into v_link;
  if not found then raise exception 'Link is not an open removal candidate'; end if;

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

-- Admin dismisses a false positive: keep it 'requested', clear the streak, and
-- re-arm the cadence so it is checked again next interval.
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
    where id = p_link_id and status = 'requested'
    returning * into v_link;
  if not found then raise exception 'Link is not an open removal candidate'; end if;

  insert into public.activity_log (contact_id, actor_id, type, description)
  values (v_link.contact_id, p_actor_id, 'link_change',
    'Removal dismissed — link still up: ' || left(v_link.url, 300));
  return v_link;
end;
$$;

revoke all on function public.dismiss_link_removal(uuid, uuid) from public, anon, authenticated;
grant execute on function public.dismiss_link_removal(uuid, uuid) to service_role;
