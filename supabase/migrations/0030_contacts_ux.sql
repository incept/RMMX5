-- Contacts UX: clients leave the general list, and a name filled by the reverse
-- phone lookup is marked so the UI can flag it as "derived, verify me".
--
-- 1. name_source records where a contact's NAME came from. Null for the ordinary
--    case (typed by a human, or arrived on a form). 'reverse_lookup' is written
--    by the Trestle enrichment when it fills a blank/placeholder name, and is
--    cleared the moment a human edits the name — a corrected name is no longer
--    uncertain.
alter table public.contacts
  add column if not exists name_source text;

comment on column public.contacts.name_source is
  'Origin of the contact name when not human-entered. ''reverse_lookup'' = filled from the phone via Trestle; cleared on manual edit.';

-- Clearing the marker belongs at the row level, not in one API path: a human
-- editing the name makes it verified truth, so the "derived from the phone
-- lookup" flag is dropped no matter which code did the update. The enrichment
-- writes name AND name_source in the same statement, so name_source already
-- differs from its old value there and this leaves that write untouched.
create or replace function public.clear_name_source_on_rename()
returns trigger
language plpgsql
as $$
begin
  if new.name is distinct from old.name
     and new.name_source is not distinct from old.name_source then
    new.name_source := null;
  end if;
  return new;
end;
$$;

drop trigger if exists clear_name_source_on_rename on public.contacts;
create trigger clear_name_source_on_rename
  before update on public.contacts
  for each row
  execute function public.clear_name_source_on_rename();

-- 2. The general "All" view now excludes client-status contacts: becoming a
--    client moves someone out of the Contacts list and into Clients. All +
--    Clients together still cover everyone. Also returns name_source so the grid
--    can show the derived-name marker.
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

-- 3. The "All" count matches the "All" view: non-clients only.
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
      'all', count(*) filter (
        where client_since is null
          and not exists (
            select 1 from public.statuses s
            where s.id = contacts.status_id and s.is_client_status
          )
      ),
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
