-- Confirming a deep-search link now also drops it into a numbered removal slot,
-- so a confirmed record is queued for removal without a second click. This RPC
-- is the slot half: it mirrors accept_search_candidate's slot logic but is keyed
-- on a URL (not a candidate) and never touches candidate status, so a confirmed
-- candidate keeps its 🔒 while its URL also lives in a slot — exactly what an
-- accepted candidate already does.
--
-- Idempotent on the URL: confirming something already in a slot returns that
-- slot instead of duplicating it. Returns NULL when all 14 slots are full, so
-- the caller can still record the confirmation and tell the operator to free a
-- slot rather than failing the whole action.
create or replace function public.place_confirmed_link(
  p_contact_id uuid,
  p_url text
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_position int;
begin
  perform 1 from public.contacts where id = p_contact_id for update;
  if not found then
    raise exception 'Contact not found' using errcode = 'P0002';
  end if;
  if p_url is null or length(p_url) > 2048 or p_url !~* '^https?://' then
    raise exception 'Link URL must be a valid HTTP(S) URL' using errcode = 'P0001';
  end if;

  -- Already occupies a slot: return it, do not duplicate.
  select position into v_position
  from public.contact_links
  where contact_id = p_contact_id and url = p_url
  order by position
  limit 1;
  if v_position is not null then
    return v_position;
  end if;

  -- Lowest free slot 1..14.
  select slot into v_position
  from generate_series(1, 14) as slot
  where not exists (
    select 1 from public.contact_links l
    where l.contact_id = p_contact_id
      and l.position = slot
      and nullif(l.url, '') is not null
  )
  order by slot
  limit 1;
  if v_position is null then
    return null; -- all 14 full; caller keeps the confirmation, just no slot
  end if;

  insert into public.contact_links (contact_id, position, url, status)
  values (p_contact_id, v_position, p_url, 'live')
  on conflict (contact_id, position) do update
    set url = excluded.url, status = excluded.status, updated_at = now();

  return v_position;
end;
$$;

revoke all on function public.place_confirmed_link(uuid, text) from public, anon, authenticated;
grant execute on function public.place_confirmed_link(uuid, text) to service_role;
