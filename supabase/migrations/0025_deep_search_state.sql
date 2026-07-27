-- 0025: deep-search state, visible on the contacts grid.
--
-- Two timestamps on contacts drive the search icon beside each contact name:
--
--   deep_search_queued_at  set when a run is enqueued, cleared when one
--                          concludes. Non-null renders "in progress" (amber).
--   deep_searched_at       set when a run concludes (even a partial one).
--                          Null with nothing queued renders "never run" (red);
--                          set renders "completed" (green).
--
-- Written by the enqueue route and the engine through the service role; the
-- grid reads them through contacts_grid_page below.

alter table public.contacts
  add column if not exists deep_searched_at timestamptz,
  add column if not exists deep_search_queued_at timestamptz;

comment on column public.contacts.deep_searched_at is
  'When the last deep search concluded (partial runs count — they keep their findings).';
comment on column public.contacts.deep_search_queued_at is
  'Set when a deep search is enqueued, cleared when a run concludes.';

-- Same function as 0020, with the two new columns in its rows.
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
      c.deep_searched_at, c.deep_search_queued_at,
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
