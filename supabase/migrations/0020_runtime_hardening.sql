-- ============================================================================
-- RMMX5 — deep-search runtime, usage accounting, and CRM scale hardening
-- Run after 0019_browser_tier.sql.
-- ============================================================================

-- Deep search is durable work. Keep the database constraint aligned with the
-- TypeScript queue union so production does not reject the job at runtime.
alter table public.job_queue
  drop constraint if exists job_queue_kind_check;
alter table public.job_queue
  add constraint job_queue_kind_check check (
    kind in (
      'auto_search', 'deep_search', 'email_delivery', 'sms_delivery',
      'voicemail_delivery', 'notification_delivery'
    )
  );

create index if not exists job_queue_lease_idx
  on public.job_queue (locked_at)
  where status = 'processing';

-- Complete usage events atomically and append provider-returned token metadata.
create or replace function public.finish_usage_event(
  p_id uuid,
  p_status text,
  p_error text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  if p_status not in ('succeeded', 'failed') then
    raise exception 'invalid usage status';
  end if;

  update public.usage_events
  set status = p_status,
      error = left(p_error, 2000),
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb),
      completed_at = now()
  where id = p_id;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke all on function public.finish_usage_event(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.finish_usage_event(uuid, text, text, jsonb)
  to service_role;

-- Aggregate in PostgreSQL. Pulling raw events through PostgREST silently hit the
-- configured row ceiling and understated both usage and spend.
create or replace function public.usage_summary_since(p_since timestamptz)
returns table (
  provider text,
  operation text,
  month text,
  status text,
  quantity bigint,
  input_tokens bigint,
  output_tokens bigint
)
language sql
security definer
set search_path = public
as $$
  select
    u.provider,
    u.operation,
    to_char(date_trunc('month', u.created_at), 'YYYY-MM') as month,
    u.status,
    sum(u.quantity)::bigint,
    sum(
      case
        when coalesce(u.metadata ->> 'input_tokens', '') ~ '^[0-9]+$'
          then (u.metadata ->> 'input_tokens')::bigint
        else 0
      end
    )::bigint as input_tokens,
    sum(
      case
        when coalesce(u.metadata ->> 'output_tokens', '') ~ '^[0-9]+$'
          then (u.metadata ->> 'output_tokens')::bigint
        else 0
      end
    )::bigint as output_tokens
  from public.usage_events u
  where u.created_at >= p_since
  group by u.provider, u.operation, date_trunc('month', u.created_at), u.status
  order by date_trunc('month', u.created_at), u.provider, u.operation, u.status;
$$;

revoke all on function public.usage_summary_since(timestamptz)
  from public, anon, authenticated;
grant execute on function public.usage_summary_since(timestamptz)
  to service_role;

-- Candidate promotion is a single serial transaction per contact. This prevents
-- two reviewers from selecting the same free slot and makes the search-view
-- invariant server-side rather than a UI-only convention.
create or replace function public.accept_search_candidate(
  p_contact_id uuid,
  p_candidate_id uuid,
  p_reviewer uuid
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidate public.search_candidates%rowtype;
  v_position int;
begin
  perform 1 from public.contacts where id = p_contact_id for update;
  if not found then
    raise exception 'Contact not found' using errcode = 'P0002';
  end if;

  select * into v_candidate
  from public.search_candidates
  where id = p_candidate_id and contact_id = p_contact_id
  for update;
  if not found then
    raise exception 'Candidate not found' using errcode = 'P0002';
  end if;

  if v_candidate.matched_facts ->> 'kind' = 'site_search' then
    raise exception 'A search view cannot be accepted into a removal link slot'
      using errcode = 'P0001';
  end if;
  if length(v_candidate.url) > 2048 or v_candidate.url !~* '^https?://' then
    raise exception 'Candidate URL must be a valid HTTP(S) URL'
      using errcode = 'P0001';
  end if;

  if v_candidate.status = 'accepted' then
    select position into v_position
    from public.contact_links
    where contact_id = p_contact_id and url = v_candidate.url
    order by position
    limit 1;
    if v_position is not null then return v_position; end if;
    raise exception 'Candidate was already accepted' using errcode = 'P0001';
  elsif v_candidate.status <> 'new' then
    raise exception 'Only new candidates can be accepted' using errcode = 'P0001';
  end if;

  select slot into v_position
  from generate_series(1, 14) as slot
  where not exists (
    select 1 from public.contact_links l
    where l.contact_id = p_contact_id and l.position = slot and nullif(l.url, '') is not null
  )
  order by slot
  limit 1;
  if v_position is null then
    raise exception 'All 14 link slots are filled — free one before accepting more'
      using errcode = 'P0001';
  end if;

  insert into public.contact_links (contact_id, position, url, status)
  values (p_contact_id, v_position, v_candidate.url, 'live')
  on conflict (contact_id, position) do update
    set url = excluded.url, status = excluded.status, updated_at = now();

  update public.search_candidates
  set status = 'accepted', reviewed_by = p_reviewer, reviewed_at = now()
  where id = p_candidate_id;

  return v_position;
end;
$$;

revoke all on function public.accept_search_candidate(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.accept_search_candidate(uuid, uuid, uuid)
  to service_role;

-- Accurate dashboard totals without downloading the whole CRM to the browser.
create or replace function public.dashboard_metrics()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contacts bigint;
  v_average numeric;
  v_clients bigint;
  v_live bigint;
  v_removed bigint;
  v_projection numeric;
  v_by_status jsonb;
begin
  if not public.is_active() then
    raise exception 'Active account required' using errcode = '42501';
  end if;

  select count(*), round(avg(reputation_score)::numeric, 1)
    into v_contacts, v_average
  from public.contacts;

  select count(*) into v_clients
  from public.contacts c
  where c.client_since is not null
     or exists (
       select 1 from public.statuses s
       where s.id = c.status_id and s.is_client_status
     );

  select
    count(*) filter (where status = 'live' and nullif(url, '') is not null),
    count(*) filter (where status = 'removed' and nullif(url, '') is not null)
    into v_live, v_removed
  from public.contact_links;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', ranked.id,
        'name', ranked.name,
        'color', ranked.color,
        'count', ranked.contact_count
      )
      order by ranked.sort_order, ranked.name
    ),
    '[]'::jsonb
  ) into v_by_status
  from (
    select s.id, s.name, s.color, s.sort_order, count(c.id)::bigint as contact_count
    from public.statuses s
    left join public.contacts c on c.status_id = s.id
    group by s.id, s.name, s.color, s.sort_order
  ) ranked;

  if public.is_admin() then
    select coalesce(sum(revenue_projection), 0) into v_projection from public.contacts;
  else
    v_projection := null;
  end if;

  return jsonb_build_object(
    'contacts', v_contacts,
    'average_reputation', v_average,
    'clients', v_clients,
    'live_links', v_live,
    'removed_links', v_removed,
    'projection_total', v_projection,
    'by_status', v_by_status
  );
end;
$$;

revoke all on function public.dashboard_metrics() from public, anon;
grant execute on function public.dashboard_metrics() to authenticated;

create or replace function public.client_summary()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count bigint;
  v_projection numeric;
begin
  if not public.is_active() then
    raise exception 'Active account required' using errcode = '42501';
  end if;
  select
    count(*),
    case when public.is_admin() then coalesce(sum(c.revenue_projection), 0) else null end
  into v_count, v_projection
  from public.contacts c
  left join public.statuses s on s.id = c.status_id
  where c.client_since is not null or s.is_client_status;
  return jsonb_build_object('count', v_count, 'projection_total', v_projection);
end;
$$;

revoke all on function public.client_summary() from public, anon;
grant execute on function public.client_summary() to authenticated;

create or replace function public.contact_view_counts()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active() then
    raise exception 'Active account required' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object(
      'all', count(*),
      'mine', count(*) filter (where owner_id = auth.uid()),
      'clients', count(*) filter (
        where client_since is not null
           or exists (
             select 1 from public.statuses s
             where s.id = contacts.status_id and s.is_client_status
           )
      ),
      'flagged', count(*) filter (where search_flag is not null),
      'recent', count(*) filter (where created_at >= now() - interval '7 days')
    )
    from public.contacts
  );
end;
$$;

revoke all on function public.contact_view_counts() from public, anon;
grant execute on function public.contact_view_counts() to authenticated;

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

  with filtered as (
    select
      c.id, c.name, c.city, c.state, c.email, c.phone, c.status_id, c.owner_id,
      c.reputation_score, c.link_score, c.search_flag, c.created_at,
      jsonb_build_object(
        'id', s.id, 'name', s.name, 'color', s.color,
        'is_client_status', s.is_client_status
      ) as statuses,
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object('id', l.id, 'url', l.url, 'status', l.status)
            order by l.position
          )
          from public.contact_links l where l.contact_id = c.id
        ),
        '[]'::jsonb
      ) as contact_links,
      coalesce(es.sent, 0)::int as email_sent,
      coalesce(es.opens, 0)::int as email_opens,
      coalesce(es.clicks, 0)::int as email_clicks
    from public.contacts c
    left join public.statuses s on s.id = c.status_id
    left join public.contact_email_stats es on es.contact_id = c.id
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
  totaled as (
    select count(*)::bigint as total_count from filtered
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
  )
  select
    coalesce(jsonb_agg(to_jsonb(paged)), '[]'::jsonb),
    (select total_count from totaled)
  into v_rows, v_total
  from paged;

  return jsonb_build_object('rows', v_rows, 'total', v_total);
end;
$$;

revoke all on function public.contacts_grid_page(text, text, uuid, text, boolean, int, int)
  from public, anon;
grant execute on function public.contacts_grid_page(text, text, uuid, text, boolean, int, int)
  to authenticated;

-- Leading-wildcard CRM search needs trigram indexes once data grows.
create extension if not exists pg_trgm;
create index if not exists contacts_name_trgm_idx
  on public.contacts using gin (name gin_trgm_ops);
create index if not exists contacts_email_trgm_idx
  on public.contacts using gin (email gin_trgm_ops);
create index if not exists contacts_phone_trgm_idx
  on public.contacts using gin (phone gin_trgm_ops);
create index if not exists contacts_client_since_idx
  on public.contacts (client_since)
  where client_since is not null;
create index if not exists usage_events_status_created_idx
  on public.usage_events (status, created_at);

-- Provider calls interrupted after reservation are no longer left as "attempted"
-- forever. They remain visible as failures and never count as successful spend.
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
  update public.usage_events
  set status = 'failed',
      error = coalesce(error, 'Provider usage reservation expired before completion'),
      completed_at = now()
  where status = 'attempted'
    and created_at < now() - interval '1 day';

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
