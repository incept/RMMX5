-- 0027: selected audit hardening (secrets, RBAC, durable workers, bounded growth).

-- ---------------------------------------------------------------------------
-- SMTP credentials must never be selectable by a browser session.
-- Keep the service-role table as the source of truth and expose only a
-- deliberately non-secret view to authenticated users.
-- ---------------------------------------------------------------------------
create or replace view public.email_accounts_safe
with (security_barrier = true)
as
select
  id, owner_id, name, from_name, from_email, smtp_host, smtp_port,
  smtp_username, smtp_secure, signature_html, is_default, created_at
from public.email_accounts
where public.is_active();

revoke all on table public.email_accounts from public, anon, authenticated;
revoke all on table public.email_accounts_safe from public, anon;
grant select on table public.email_accounts_safe to authenticated;
grant select, insert, update, delete on table public.email_accounts to service_role;

-- Marketing content and delivery state is readable by workers, but only
-- administrators may mutate campaigns, enrollment, or delivery records.
drop policy if exists "templates all" on public.email_templates;
drop policy if exists "lists all" on public.email_lists;
drop policy if exists "list members all" on public.email_list_members;
drop policy if exists "sequences all" on public.email_sequences;
drop policy if exists "steps all" on public.sequence_steps;
drop policy if exists "enrollments all" on public.sequence_enrollments;
drop policy if exists "messages all" on public.email_messages;

create policy "templates select" on public.email_templates for select using (public.is_active());
create policy "templates admin write" on public.email_templates for all
  using (public.is_admin()) with check (public.is_admin());
create policy "lists select" on public.email_lists for select using (public.is_active());
create policy "lists admin write" on public.email_lists for all
  using (public.is_admin()) with check (public.is_admin());
create policy "list members select" on public.email_list_members for select using (public.is_active());
create policy "list members admin write" on public.email_list_members for all
  using (public.is_admin()) with check (public.is_admin());
create policy "sequences select" on public.email_sequences for select using (public.is_active());
create policy "sequences admin write" on public.email_sequences for all
  using (public.is_admin()) with check (public.is_admin());
create policy "steps select" on public.sequence_steps for select using (public.is_active());
create policy "steps admin write" on public.sequence_steps for all
  using (public.is_admin()) with check (public.is_admin());
create policy "enrollments select" on public.sequence_enrollments for select using (public.is_active());
create policy "enrollments admin write" on public.sequence_enrollments for all
  using (public.is_admin()) with check (public.is_admin());
create policy "messages select" on public.email_messages for select using (public.is_active());
create policy "messages admin write" on public.email_messages for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "sms campaigns all" on public.sms_campaigns;
drop policy if exists "sms messages all" on public.sms_messages;
drop policy if exists "vm drops all" on public.voicemail_drops;
drop policy if exists "vm sends all" on public.voicemail_sends;
create policy "sms campaigns select" on public.sms_campaigns for select using (public.is_active());
create policy "sms campaigns admin write" on public.sms_campaigns for all
  using (public.is_admin()) with check (public.is_admin());
create policy "sms messages select" on public.sms_messages for select using (public.is_active());
create policy "sms messages admin write" on public.sms_messages for all
  using (public.is_admin()) with check (public.is_admin());
create policy "vm drops select" on public.voicemail_drops for select using (public.is_active());
create policy "vm drops admin write" on public.voicemail_drops for all
  using (public.is_admin()) with check (public.is_admin());
create policy "vm sends select" on public.voicemail_sends for select using (public.is_active());
create policy "vm sends admin write" on public.voicemail_sends for all
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Deep-search generation identity. A superseded or lease-lost worker cannot
-- clear or overwrite the state belonging to a newer run.
-- ---------------------------------------------------------------------------
alter table public.contacts
  add column if not exists deep_search_job_id uuid references public.job_queue(id) on delete set null;

create index if not exists contacts_deep_search_job_idx
  on public.contacts (deep_search_job_id)
  where deep_search_job_id is not null;

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
    deep_search_queued_at = null,
    deep_search_job_id = null
  where id = p_contact_id and deep_search_job_id = p_job_id;
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
  update public.contacts
  set
    deep_search_queued_at = null,
    deep_search_job_id = null,
    search_flag = left(p_message, 500),
    search_flagged_at = now()
  where id = p_contact_id and deep_search_job_id = p_job_id;
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

-- ---------------------------------------------------------------------------
-- Voicemail storage lifecycle and quotas.
-- ---------------------------------------------------------------------------
alter table public.voicemail_drops
  add column if not exists size_bytes bigint not null default 0
    check (size_bytes >= 0 and size_bytes <= 26214400),
  add column if not exists lifecycle_status text not null default 'active'
    check (lifecycle_status in ('active', 'deleting'));

create index if not exists voicemail_drops_active_created_idx
  on public.voicemail_drops (created_at desc)
  where lifecycle_status = 'active';

create or replace function public.enforce_voicemail_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count bigint;
  v_bytes bigint;
begin
  perform pg_advisory_xact_lock(hashtext('voicemail-storage-quota'));
  select count(*), coalesce(sum(size_bytes), 0)
    into v_count, v_bytes
  from public.voicemail_drops
  where lifecycle_status = 'active'
    and (tg_op = 'INSERT' or id <> new.id);
  if new.lifecycle_status = 'active' and v_count >= 100 then
    raise exception 'Voicemail storage is limited to 100 recordings';
  end if;
  if new.lifecycle_status = 'active' and v_bytes + new.size_bytes > 524288000 then
    raise exception 'Voicemail storage is limited to 500 MB';
  end if;
  return new;
end;
$$;

drop trigger if exists voicemail_quota_guard on public.voicemail_drops;
create trigger voicemail_quota_guard
before insert or update of size_bytes, lifecycle_status on public.voicemail_drops
for each row execute function public.enforce_voicemail_quota();

create or replace function public.prepare_voicemail_drop_delete(p_drop_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_path text;
begin
  select audio_path into v_path
  from public.voicemail_drops
  where id = p_drop_id
  for update;
  if not found then return null; end if;

  perform 1
  from public.job_queue j
  where j.kind = 'voicemail_delivery'
    and j.status in ('pending', 'processing')
    and exists (
      select 1 from public.voicemail_sends s
      where s.drop_id = p_drop_id and j.payload ->> 'sendId' = s.id::text
    )
  for update;
  if exists (
    select 1 from public.job_queue j
    where j.kind = 'voicemail_delivery'
      and j.status = 'processing'
      and exists (
        select 1 from public.voicemail_sends s
        where s.drop_id = p_drop_id and j.payload ->> 'sendId' = s.id::text
      )
  ) then
    raise exception 'A delivery is currently in progress; retry deletion after it finishes';
  end if;

  update public.voicemail_drops
  set lifecycle_status = 'deleting'
  where id = p_drop_id;

  update public.job_queue j
  set status = 'failed',
      locked_at = null,
      locked_by = null,
      last_error = 'Voicemail recording deleted by administrator',
      updated_at = now()
  where j.kind = 'voicemail_delivery'
    and j.status = 'pending'
    and exists (
      select 1 from public.voicemail_sends s
      where s.drop_id = p_drop_id and j.payload ->> 'sendId' = s.id::text
    );

  update public.voicemail_sends
  set status = 'failed', error = 'Voicemail recording deleted by administrator'
  where drop_id = p_drop_id and status = 'queued';
  return v_path;
end;
$$;

revoke all on function public.prepare_voicemail_drop_delete(uuid)
  from public, anon, authenticated;
grant execute on function public.prepare_voicemail_drop_delete(uuid) to service_role;

-- Summary RPC prevents the voicemail screen from materializing every historic
-- send row just to show three counters.
create or replace function public.voicemail_drop_summaries(
  p_limit int default 50,
  p_offset int default 0
)
returns table (
  id uuid, name text, audio_path text, size_bytes bigint, created_at timestamptz,
  queued_count bigint, sent_count bigint, failed_count bigint
)
language sql
security definer
set search_path = public
as $$
  select d.id, d.name, d.audio_path, d.size_bytes, d.created_at,
    count(s.id) filter (where s.status = 'queued'),
    count(s.id) filter (where s.status = 'sent'),
    count(s.id) filter (where s.status = 'failed')
  from public.voicemail_drops d
  left join public.voicemail_sends s on s.drop_id = d.id
  where public.is_active() and d.lifecycle_status = 'active'
  group by d.id
  order by d.created_at desc
  limit least(greatest(p_limit, 1), 100)
  offset greatest(p_offset, 0);
$$;

revoke all on function public.voicemail_drop_summaries(int, int) from public, anon;
grant execute on function public.voicemail_drop_summaries(int, int) to authenticated;

create or replace function public.refresh_sms_campaign_counts(p_campaign_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.sms_campaigns c
  set
    status = case
      when totals.queued > 0 then 'sending'
      when totals.failed > 0 and totals.sent = 0 then 'failed'
      else 'sent'
    end,
    sent_count = totals.sent,
    failed_count = totals.failed
  from (
    select
      count(*) filter (where status = 'queued')::int as queued,
      count(*) filter (where status = 'sent')::int as sent,
      count(*) filter (where status = 'failed')::int as failed
    from public.sms_messages
    where campaign_id = p_campaign_id
  ) totals
  where c.id = p_campaign_id;
$$;

revoke all on function public.refresh_sms_campaign_counts(uuid)
  from public, anon, authenticated;
grant execute on function public.refresh_sms_campaign_counts(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Merge/file safety and indexes for the high-volume contact paths.
-- ---------------------------------------------------------------------------
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
  perform pg_advisory_xact_lock(hashtext('contact-file-quota:' || new.contact_id::text));
  select count(*), coalesce(sum(size_bytes), 0)
    into v_count, v_bytes
  from public.contact_files
  where contact_id = new.contact_id
    and (tg_op = 'INSERT' or id <> new.id);
  if v_count >= 50 then raise exception 'A contact may have at most 50 files'; end if;
  if v_bytes + new.size_bytes > 104857600 then
    raise exception 'A contact may store at most 100 MB of files';
  end if;
  return new;
end;
$$;

drop trigger if exists contact_file_quota_guard on public.contact_files;
create trigger contact_file_quota_guard
before insert or update of contact_id, size_bytes on public.contact_files
for each row execute function public.enforce_contact_file_quota();

create or replace function public.cancel_jobs_for_deleted_contact()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1
  from public.job_queue
  where status in ('pending', 'processing')
    and payload ->> 'contactId' = old.id::text
  for update;
  if exists (
    select 1 from public.job_queue
    where status = 'processing'
      and payload ->> 'contactId' = old.id::text
  ) then
    raise exception 'Contact has background work in progress; retry when it finishes';
  end if;
  update public.job_queue
  set status = 'failed',
      locked_at = null,
      locked_by = null,
      last_error = 'Contact was deleted or merged',
      updated_at = now()
  where status = 'pending'
    and payload ->> 'contactId' = old.id::text;
  return old;
end;
$$;

drop trigger if exists cancel_jobs_before_contact_delete on public.contacts;
create trigger cancel_jobs_before_contact_delete
before delete on public.contacts
for each row execute function public.cancel_jobs_for_deleted_contact();

create index if not exists job_queue_contact_payload_idx
  on public.job_queue ((payload ->> 'contactId'))
  where status in ('pending', 'processing');
create index if not exists contact_files_contact_idx on public.contact_files(contact_id);
create index if not exists email_messages_contact_created_idx
  on public.email_messages(contact_id, created_at desc);
create index if not exists sms_messages_campaign_status_idx
  on public.sms_messages(campaign_id, status);
create index if not exists voicemail_sends_drop_status_idx
  on public.voicemail_sends(drop_id, status);
create index if not exists sequence_enrollments_contact_status_idx
  on public.sequence_enrollments(contact_id, status);

-- ---------------------------------------------------------------------------
-- Retention functions delete bounded batches. Repeated cron ticks drain a
-- backlog without one giant transaction or latency spike.
-- ---------------------------------------------------------------------------
create or replace function public.prune_debug_log(p_keep_days int default 14)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  with doomed as (
    select ctid from public.debug_log
    where created_at < now() - make_interval(days => greatest(p_keep_days, 1))
    order by created_at
    limit 5000
  )
  delete from public.debug_log d using doomed
  where d.ctid = doomed.ctid;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.prune_growth_tables()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_usage int := 0; v_jobs int := 0; v_events int := 0; v_notifications int := 0;
begin
  with d as (
    select ctid from public.usage_events
    where created_at < now() - interval '400 days'
    order by created_at limit 5000
  ) delete from public.usage_events t using d where t.ctid = d.ctid;
  get diagnostics v_usage = row_count;

  with d as (
    select ctid from public.job_queue
    where status in ('completed', 'failed') and updated_at < now() - interval '30 days'
    order by updated_at limit 5000
  ) delete from public.job_queue t using d where t.ctid = d.ctid;
  get diagnostics v_jobs = row_count;

  with d as (
    select ctid from public.email_events
    where created_at < now() - interval '400 days'
    order by created_at limit 5000
  ) delete from public.email_events t using d where t.ctid = d.ctid;
  get diagnostics v_events = row_count;

  with d as (
    select ctid from public.notifications_log
    where created_at < now() - interval '180 days'
    order by created_at limit 5000
  ) delete from public.notifications_log t using d where t.ctid = d.ctid;
  get diagnostics v_notifications = row_count;

  return jsonb_build_object(
    'usage_events', v_usage,
    'job_queue', v_jobs,
    'email_events', v_events,
    'notifications_log', v_notifications
  );
end;
$$;

revoke all on function public.prune_debug_log(int) from public, anon, authenticated;
revoke all on function public.prune_growth_tables() from public, anon, authenticated;
grant execute on function public.prune_debug_log(int) to service_role;
grant execute on function public.prune_growth_tables() to service_role;

-- Incremental engagement counters avoid grouping the entire email history on
-- every contacts-grid request.
create table if not exists public.contact_email_counters (
  contact_id uuid primary key references public.contacts(id) on delete cascade,
  sent int not null default 0 check (sent >= 0),
  opens int not null default 0 check (opens >= 0),
  clicks int not null default 0 check (clicks >= 0)
);

insert into public.contact_email_counters (contact_id, sent, opens, clicks)
select
  m.contact_id,
  count(*) filter (where m.direction = 'outbound' and m.status = 'sent')::int,
  coalesce(sum(m.open_count), 0)::int,
  coalesce(sum(m.click_count), 0)::int
from public.email_messages m
where m.contact_id is not null
group by m.contact_id
on conflict (contact_id) do update
set sent = excluded.sent, opens = excluded.opens, clicks = excluded.clicks;

create or replace function public.sync_contact_email_counters()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_sent int := 0; v_old_opens int := 0; v_old_clicks int := 0;
  v_new_sent int := 0; v_new_opens int := 0; v_new_clicks int := 0;
begin
  if tg_op <> 'INSERT' and old.contact_id is not null then
    v_old_sent := case when old.direction = 'outbound' and old.status = 'sent' then 1 else 0 end;
    v_old_opens := old.open_count;
    v_old_clicks := old.click_count;
    insert into public.contact_email_counters(contact_id)
    values (old.contact_id) on conflict do nothing;
    update public.contact_email_counters
    set
      sent = greatest(sent - v_old_sent, 0),
      opens = greatest(opens - v_old_opens, 0),
      clicks = greatest(clicks - v_old_clicks, 0)
    where contact_id = old.contact_id;
  end if;
  if tg_op <> 'DELETE' and new.contact_id is not null then
    v_new_sent := case when new.direction = 'outbound' and new.status = 'sent' then 1 else 0 end;
    v_new_opens := new.open_count;
    v_new_clicks := new.click_count;
    insert into public.contact_email_counters(contact_id, sent, opens, clicks)
    values (new.contact_id, v_new_sent, v_new_opens, v_new_clicks)
    on conflict (contact_id) do update
    set
      sent = public.contact_email_counters.sent + excluded.sent,
      opens = public.contact_email_counters.opens + excluded.opens,
      clicks = public.contact_email_counters.clicks + excluded.clicks;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists email_message_counter_sync on public.email_messages;
create trigger email_message_counter_sync
after insert or update of contact_id, direction, status, open_count, click_count
or delete on public.email_messages
for each row execute function public.sync_contact_email_counters();

revoke all on table public.contact_email_counters from public, anon, authenticated;
grant select, insert, update, delete on table public.contact_email_counters to service_role;

-- Page the inexpensive contact rows first; build link JSON only for the
-- requested page. This removes the O(all contacts * all links) default-grid
-- query while preserving email-stat sorting.
create or replace function public.contacts_grid_page(
  p_search text default '',
  p_view text default 'all',
  p_status uuid default null,
  p_sort text default 'created_at',
  p_ascending boolean default false,
  p_page int default 0,
  p_page_size int default 50
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
  v_total bigint;
begin
  if not public.is_active() then
    raise exception 'Active account required' using errcode = '42501';
  end if;
  if p_view not in ('all', 'mine', 'clients', 'flagged', 'recent') then
    raise exception 'Invalid contact view';
  end if;
  if p_sort not in (
    'name', 'created_at', 'reputation_score', 'link_score', 'status',
    'email_sent', 'email_opens', 'email_clicks'
  ) then
    raise exception 'Invalid contact sort';
  end if;

  with filtered as materialized (
    select
      c.id, c.name, c.city, c.state, c.email, c.phone, c.status_id, c.owner_id,
      c.reputation_score, c.link_score, c.search_flag, c.created_at,
      c.deep_searched_at, c.deep_search_queued_at,
      jsonb_build_object(
        'id', s.id, 'name', s.name, 'color', s.color,
        'is_client_status', s.is_client_status
      ) as statuses,
      coalesce(es.sent, 0)::int as email_sent,
      coalesce(es.opens, 0)::int as email_opens,
      coalesce(es.clicks, 0)::int as email_clicks
    from public.contacts c
    left join public.statuses s on s.id = c.status_id
    left join public.contact_email_counters es on es.contact_id = c.id
    where
      (
        nullif(btrim(p_search), '') is null
        or c.name ilike '%' || btrim(p_search) || '%'
        or c.email ilike '%' || btrim(p_search) || '%'
        or c.phone ilike '%' || btrim(p_search) || '%'
      )
      and (p_status is null or c.status_id = p_status)
      and (
        p_view = 'all'
        or (p_view = 'mine' and c.owner_id = auth.uid())
        or (p_view = 'clients' and (c.client_since is not null or s.is_client_status))
        or (p_view = 'flagged' and c.search_flag is not null)
        or (p_view = 'recent' and c.created_at >= now() - interval '7 days')
      )
  ),
  paged as (
    select *
    from filtered
    order by
      case when p_sort = 'name' and p_ascending then lower(name) end asc,
      case when p_sort = 'name' and not p_ascending then lower(name) end desc,
      case when p_sort = 'created_at' and p_ascending then created_at end asc,
      case when p_sort = 'created_at' and not p_ascending then created_at end desc,
      case when p_sort = 'reputation_score' and p_ascending then reputation_score end asc nulls last,
      case when p_sort = 'reputation_score' and not p_ascending then reputation_score end desc nulls last,
      case when p_sort = 'link_score' and p_ascending then link_score end asc nulls last,
      case when p_sort = 'link_score' and not p_ascending then link_score end desc nulls last,
      case when p_sort = 'status' and p_ascending then statuses ->> 'name' end asc,
      case when p_sort = 'status' and not p_ascending then statuses ->> 'name' end desc,
      case when p_sort = 'email_sent' and p_ascending then email_sent end asc,
      case when p_sort = 'email_sent' and not p_ascending then email_sent end desc,
      case when p_sort = 'email_opens' and p_ascending then email_opens end asc,
      case when p_sort = 'email_opens' and not p_ascending then email_opens end desc,
      case when p_sort = 'email_clicks' and p_ascending then email_clicks end asc,
      case when p_sort = 'email_clicks' and not p_ascending then email_clicks end desc,
      created_at desc, id
    limit least(greatest(p_page_size, 1), 200)
    offset greatest(p_page, 0) * least(greatest(p_page_size, 1), 200)
  ),
  decorated as (
    select
      p.*,
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object('id', l.id, 'url', l.url, 'status', l.status)
            order by l.position
          )
          from public.contact_links l
          where l.contact_id = p.id
        ),
        '[]'::jsonb
      ) as contact_links
    from paged p
  )
  select
    coalesce((select jsonb_agg(to_jsonb(decorated)) from decorated), '[]'::jsonb),
    (select count(*)::bigint from filtered)
  into v_rows, v_total;

  return jsonb_build_object('rows', v_rows, 'total', v_total);
end;
$$;

revoke all on function public.contacts_grid_page(text, text, uuid, text, boolean, int, int)
  from public, anon;
grant execute on function public.contacts_grid_page(text, text, uuid, text, boolean, int, int)
  to authenticated;

-- Status mutations and their side-effect outbox are committed together.
alter table public.job_queue drop constraint if exists job_queue_kind_check;
alter table public.job_queue
  add constraint job_queue_kind_check check (
    kind in (
      'auto_search', 'deep_search', 'contact_enrichment', 'score_contact',
      'email_delivery', 'sms_delivery', 'voicemail_delivery',
      'notification_delivery', 'contact_side_effects'
    )
  );

create or replace function public.update_contact_status_atomic(
  p_contact_id uuid,
  p_expected_updated_at timestamptz,
  p_updates jsonb,
  p_actor_id uuid
)
returns public.contacts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.contacts%rowtype;
  v_after public.contacts%rowtype;
  v_job_id uuid := gen_random_uuid();
begin
  select * into v_before
  from public.contacts
  where id = p_contact_id
  for update;
  if not found then raise exception 'Contact not found'; end if;
  if v_before.updated_at <> p_expected_updated_at then
    raise exception 'Contact changed since it was loaded' using errcode = '40001';
  end if;

  update public.contacts c
  set
    name = case when p_updates ? 'name' then p_updates ->> 'name' else c.name end,
    city = case when p_updates ? 'city' then p_updates ->> 'city' else c.city end,
    state = case when p_updates ? 'state' then p_updates ->> 'state' else c.state end,
    email = case when p_updates ? 'email' then p_updates ->> 'email' else c.email end,
    phone = case when p_updates ? 'phone' then p_updates ->> 'phone' else c.phone end,
    status_id = case
      when p_updates ? 'status_id' and nullif(p_updates ->> 'status_id', '') is null then null
      when p_updates ? 'status_id' then (p_updates ->> 'status_id')::uuid
      else c.status_id end,
    browser = case when p_updates ? 'browser' then p_updates ->> 'browser' else c.browser end,
    ppc_kw = case when p_updates ? 'ppc_kw' then p_updates ->> 'ppc_kw' else c.ppc_kw end,
    source = case when p_updates ? 'source' then p_updates ->> 'source' else c.source end,
    ip = case when p_updates ? 'ip' then p_updates ->> 'ip' else c.ip end,
    utm = case when p_updates ? 'utm' then p_updates ->> 'utm' else c.utm end,
    stage_id = case
      when p_updates ? 'stage_id' and nullif(p_updates ->> 'stage_id', '') is null then null
      when p_updates ? 'stage_id' then (p_updates ->> 'stage_id')::uuid
      else c.stage_id end,
    client_since = case
      when p_updates ? 'client_since' and nullif(p_updates ->> 'client_since', '') is null then null
      when p_updates ? 'client_since' then (p_updates ->> 'client_since')::timestamptz
      else c.client_since end,
    service_days = case
      when p_updates ? 'service_days' and (p_updates -> 'service_days') = 'null'::jsonb then null
      when p_updates ? 'service_days' then (p_updates ->> 'service_days')::int
      else c.service_days end,
    custom = case when p_updates ? 'custom' then p_updates -> 'custom' else c.custom end,
    owner_id = case
      when p_updates ? 'owner_id' and nullif(p_updates ->> 'owner_id', '') is null then null
      when p_updates ? 'owner_id' then (p_updates ->> 'owner_id')::uuid
      else c.owner_id end,
    device = case when p_updates ? 'device' then p_updates ->> 'device' else c.device end,
    source_url = case when p_updates ? 'source_url' then p_updates ->> 'source_url' else c.source_url end,
    wp_user = case when p_updates ? 'wp_user' then p_updates ->> 'wp_user' else c.wp_user end,
    gclid = case when p_updates ? 'gclid' then p_updates ->> 'gclid' else c.gclid end
  where c.id = p_contact_id
  returning * into v_after;

  insert into public.activity_log (contact_id, actor_id, type, description, meta)
  values (
    p_contact_id, p_actor_id, 'status_change', 'Contact status change queued',
    jsonb_build_object('from', v_before.status_id, 'to', v_after.status_id)
  );
  insert into public.job_queue (id, kind, payload, dedupe_key)
  values (
    v_job_id,
    'contact_side_effects',
    jsonb_build_object(
      'event', 'status_change',
      'contactId', p_contact_id,
      'actorId', p_actor_id,
      'fromStatusId', v_before.status_id,
      'toStatusId', v_after.status_id
    ),
    'contact-status:' || p_contact_id::text || ':' || v_job_id::text
  );
  return v_after;
end;
$$;

revoke all on function public.update_contact_status_atomic(uuid, timestamptz, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.update_contact_status_atomic(uuid, timestamptz, jsonb, uuid)
  to service_role;

create or replace function public.replace_contact_links_atomic(
  p_contact_id uuid,
  p_links jsonb,
  p_actor_id uuid
)
returns setof public.contact_links
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from public.contacts where id = p_contact_id for update;
  if not found then raise exception 'Contact not found'; end if;
  if jsonb_typeof(p_links) <> 'array' or jsonb_array_length(p_links) > 14 then
    raise exception 'Invalid links payload';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_links) x(position int, url text, status text)
    group by position
    having position not between 1 and 14 or count(*) > 1
  ) then
    raise exception 'Invalid or duplicate link position';
  end if;

  insert into public.job_queue (kind, payload, dedupe_key)
  select
    'contact_side_effects',
    jsonb_build_object(
      'event', 'link_status_change',
      'contactId', p_contact_id,
      'actorId', p_actor_id,
      'link', x.url,
      'linkStatus', x.status
    ),
    'contact-link-status:' || p_contact_id::text || ':' || x.position::text || ':' ||
      gen_random_uuid()::text
  from jsonb_to_recordset(p_links) x(position int, url text, status text)
  join public.contact_links l
    on l.contact_id = p_contact_id and l.position = x.position
  where l.url = x.url and l.status <> x.status and nullif(btrim(x.url), '') is not null;

  delete from public.contact_links l
  using jsonb_to_recordset(p_links) x(position int, url text, status text)
  where l.contact_id = p_contact_id and l.position = x.position
    and nullif(btrim(x.url), '') is null;

  insert into public.contact_links (contact_id, position, url, status, updated_at)
  select p_contact_id, x.position, x.url, x.status, now()
  from jsonb_to_recordset(p_links) x(position int, url text, status text)
  where nullif(btrim(x.url), '') is not null
    and x.status in ('live', 'requested', 'removed')
  on conflict (contact_id, position) do update
    set url = excluded.url, status = excluded.status, updated_at = now();

  return query
    select * from public.contact_links
    where contact_id = p_contact_id
    order by position;
end;
$$;

revoke all on function public.replace_contact_links_atomic(uuid, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.replace_contact_links_atomic(uuid, jsonb, uuid) to service_role;

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
    returning id, kind, payload, attempt_count, last_error
  ),
  cleared as (
    update public.contacts c
    set
      deep_search_queued_at = null,
      deep_search_job_id = null,
      search_flag = left(
        'the last deep search failed after ' || e.attempt_count::text ||
        ' attempts (' || coalesce(e.last_error, 'lease expired') || ')',
        500
      ),
      search_flagged_at = now()
    from exhausted e
    where e.kind = 'deep_search'
      and c.id = (e.payload ->> 'contactId')::uuid
      and c.deep_search_job_id = e.id
    returning c.id
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

create or replace function public.prune_webhook_tables(
  p_receipt_keep_days int default 30,
  p_lead_keep_days int default 90
)
returns table (receipts_deleted int, leads_deleted int)
language plpgsql
security definer
set search_path = public
as $$
declare v_receipts int; v_leads int;
begin
  with d as (
    select ctid from public.webhook_receipts
    where received_at < now() - make_interval(days => greatest(p_receipt_keep_days, 1))
    order by received_at limit 5000
  ) delete from public.webhook_receipts t using d where t.ctid = d.ctid;
  get diagnostics v_receipts = row_count;
  with d as (
    select ctid from public.webhook_leads
    where created_at < now() - make_interval(days => greatest(p_lead_keep_days, 1))
    order by created_at limit 5000
  ) delete from public.webhook_leads t using d where t.ctid = d.ctid;
  get diagnostics v_leads = row_count;
  return query select v_receipts, v_leads;
end;
$$;

create or replace function public.prune_operational_tables()
returns table (jobs_deleted int, leases_deleted int, usage_deleted int)
language plpgsql
security definer
set search_path = public
as $$
declare v_jobs int; v_leases int; v_usage int;
begin
  with d as (
    select id from public.usage_events
    where status = 'attempted' and created_at < now() - interval '1 day'
    order by created_at limit 5000
  )
  update public.usage_events u
  set status = 'failed',
      error = coalesce(error, 'Provider usage reservation expired before completion'),
      completed_at = now()
  from d where u.id = d.id;

  with d as (
    select ctid from public.job_queue
    where (status = 'completed' and completed_at < now() - interval '30 days')
       or (status = 'failed' and updated_at < now() - interval '90 days')
    order by updated_at limit 5000
  ) delete from public.job_queue t using d where t.ctid = d.ctid;
  get diagnostics v_jobs = row_count;

  with d as (
    select ctid from public.app_leases
    where expires_at < now() - interval '1 day'
    order by expires_at limit 5000
  ) delete from public.app_leases t using d where t.ctid = d.ctid;
  get diagnostics v_leases = row_count;

  with d as (
    select ctid from public.usage_events
    where created_at < now() - interval '25 months'
    order by created_at limit 5000
  ) delete from public.usage_events t using d where t.ctid = d.ctid;
  get diagnostics v_usage = row_count;
  return query select v_jobs, v_leases, v_usage;
end;
$$;

revoke all on function public.prune_webhook_tables(int, int)
  from public, anon, authenticated;
revoke all on function public.prune_operational_tables()
  from public, anon, authenticated;
grant execute on function public.prune_webhook_tables(int, int) to service_role;
grant execute on function public.prune_operational_tables() to service_role;
