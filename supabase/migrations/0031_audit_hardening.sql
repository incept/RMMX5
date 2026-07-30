-- ============================================================================
-- RMMX5 — audit hardening: authorization, lease-fenced writes, and bounded growth
-- Run after 0030_contacts_ux.sql.
-- ============================================================================

-- Workers use explicit safe columns. Revenue remains server/admin-only, and all
-- updates flow through validated API/RPC paths so a direct PostgREST call cannot
-- bypass status side effects, ownership checks, or search-state lease guards.
revoke select, insert, update on table public.contacts from authenticated;
grant select (
  id, name, name_source, city, state, email, phone, status_id,
  reputation_score, link_score, browser, ppc_kw, source, ip, utm,
  stage_id, client_since, service_days, custom, owner_id,
  created_at, updated_at, device, source_url, wp_user, submitted_at, gclid,
  search_flag, search_flagged_at, email_normalized, phone_normalized,
  search_facts, confirmed_facts, deep_searched_at, deep_search_queued_at,
  deep_search_job_id, deep_search_flag_job_id
) on table public.contacts to authenticated;
grant insert (
  name, city, state, email, phone, status_id, browser, ppc_kw, source, ip, utm,
  custom, owner_id, device, source_url, wp_user, submitted_at, gclid,
  confirmed_facts
) on table public.contacts to authenticated;

-- Candidate batches are admitted only while the exact worker attempt still owns
-- a fresh lease. Locking that queue row serializes this write with reclaim and
-- finalization; a stale worker receives -1 and cannot publish review rows.
create or replace function public.write_deep_search_candidates(
  p_job_id uuid,
  p_worker text,
  p_attempt_count int,
  p_rows jsonb
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact_id uuid;
  v_count int := 0;
begin
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'Candidate batch must be an array';
  end if;

  select nullif(j.payload ->> 'contactId', '')::uuid
  into v_contact_id
  from public.job_queue j
  where j.id = p_job_id
    and j.kind = 'deep_search'
    and j.status = 'processing'
    and j.locked_by = p_worker
    and j.attempt_count = p_attempt_count
    and j.locked_at >= now() - interval '300 seconds'
  for update;

  if v_contact_id is null then return -1; end if;

  insert into public.search_candidates (
    contact_id, url, canonical_url, title, snippet, source, source_detail,
    round, confidence, matched_facts, url_rule_id
  )
  select
    v_contact_id,
    left(x.url, 4096),
    left(x.canonical_url, 4096),
    nullif(left(x.title, 300), ''),
    nullif(left(x.snippet, 2000), ''),
    x.source,
    nullif(left(x.source_detail, 500), ''),
    greatest(coalesce(x.round, 0), 0),
    least(greatest(coalesce(x.confidence, 0), 0), 1),
    coalesce(x.matched_facts, '{}'::jsonb),
    x.url_rule_id
  from jsonb_to_recordset(p_rows) as x(
    contact_id uuid,
    url text,
    canonical_url text,
    title text,
    snippet text,
    source text,
    source_detail text,
    round int,
    confidence numeric,
    matched_facts jsonb,
    url_rule_id uuid
  )
  where x.contact_id = v_contact_id
    and nullif(btrim(x.url), '') is not null
    and nullif(btrim(x.canonical_url), '') is not null
    and x.source in ('probe', 'google', 'bing')
  on conflict (contact_id, canonical_url) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.write_deep_search_candidates(uuid, text, int, jsonb)
  from public, anon, authenticated;
grant execute on function public.write_deep_search_candidates(uuid, text, int, jsonb)
  to service_role;

-- Leading-wildcard contact searches previously forced full table scans. Trigram
-- indexes cover those searches, while NOT MATERIALIZED lets the planner page via
-- an index before decorating rows instead of building the complete result set.
create extension if not exists pg_trgm;
create index if not exists contacts_name_trgm_idx
  on public.contacts using gin (name gin_trgm_ops);
create index if not exists contacts_email_trgm_idx
  on public.contacts using gin (email gin_trgm_ops);
create index if not exists contacts_phone_trgm_idx
  on public.contacts using gin (phone gin_trgm_ops);
create index if not exists contacts_owner_created_idx
  on public.contacts(owner_id, created_at desc);
create index if not exists contacts_client_since_idx
  on public.contacts(client_since) where client_since is not null;
create index if not exists contacts_search_flag_idx
  on public.contacts(created_at desc) where search_flag is not null;

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

  with filtered as not materialized (
    select
      c.id, c.name, c.name_source, c.city, c.state, c.email, c.phone,
      c.status_id, c.owner_id,
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
        -- "All" is the general (non-client) list: a client belongs under Clients.
        (p_view = 'all' and c.client_since is null and not coalesce(s.is_client_status, false))
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



create index if not exists search_candidates_status_created_idx
  on public.search_candidates(status, created_at);
create index if not exists activity_log_created_idx
  on public.activity_log(created_at);
create index if not exists calls_processing_created_idx
  on public.calls(processing_status, created_at);
create index if not exists email_messages_created_idx
  on public.email_messages(created_at);
create index if not exists imports_created_idx
  on public.imports(created_at);

-- Manual administrator purges use the requested age for every candidate
-- status, including abandoned unreviewed rows.
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
      delete from public.search_candidates
      where created_at < now() - make_interval(days => p_older_than_days);
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

-- Each cron tick drains at most 5,000 rows per category. Conservative windows
-- preserve useful CRM history while preventing forgotten queues and logs from
-- growing forever.
create or replace function public.prune_growth_tables()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_usage int := 0; v_jobs int := 0; v_events int := 0; v_notifications int := 0;
  v_candidates int := 0; v_activity int := 0; v_calls int := 0;
  v_messages int := 0; v_imports int := 0;
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

  with d as (
    select ctid from public.search_candidates
    where (status = 'new' and created_at < now() - interval '180 days')
       or (status in ('accepted', 'rejected', 'confirmed')
           and created_at < now() - interval '400 days')
    order by created_at limit 5000
  ) delete from public.search_candidates t using d where t.ctid = d.ctid;
  get diagnostics v_candidates = row_count;

  with d as (
    select ctid from public.activity_log
    where created_at < now() - interval '730 days'
    order by created_at limit 5000
  ) delete from public.activity_log t using d where t.ctid = d.ctid;
  get diagnostics v_activity = row_count;

  with d as (
    select ctid from public.calls
    where processing_status = 'completed' and created_at < now() - interval '730 days'
    order by created_at limit 5000
  ) delete from public.calls t using d where t.ctid = d.ctid;
  get diagnostics v_calls = row_count;

  with d as (
    select ctid from public.email_messages
    where created_at < now() - interval '730 days'
    order by created_at limit 5000
  ) delete from public.email_messages t using d where t.ctid = d.ctid;
  get diagnostics v_messages = row_count;

  with d as (
    select ctid from public.imports
    where created_at < now() - interval '180 days'
    order by created_at limit 5000
  ) delete from public.imports t using d where t.ctid = d.ctid;
  get diagnostics v_imports = row_count;

  return jsonb_build_object(
    'usage_events', v_usage,
    'job_queue', v_jobs,
    'email_events', v_events,
    'notifications_log', v_notifications,
    'search_candidates', v_candidates,
    'activity_log', v_activity,
    'calls', v_calls,
    'email_messages', v_messages,
    'imports', v_imports
  );
end;
$$;
revoke all on function public.prune_growth_tables() from public, anon, authenticated;
grant execute on function public.prune_growth_tables() to service_role;
