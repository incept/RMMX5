-- Let the contact importer preserve a lead's original date. The import wizard
-- now offers a "Date created" mapping target; the route parses that cell to an
-- ISO timestamp (or null) and passes it as v_row.created_at. This re-defines
-- import_contact_chunk to honour it, falling back to now() when absent — every
-- other line is unchanged from 0024.
create or replace function public.import_contact_chunk(
  p_request_key text,
  p_rows jsonb,
  p_created_by uuid
)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing uuid[];
  v_ids uuid[] := '{}';
  v_row jsonb;
  v_contact_id uuid;
  v_link jsonb;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 100 then
    raise exception 'Import chunks must contain 1 to 100 rows';
  end if;
  select contact_ids into v_existing
  from public.import_chunks where request_key = p_request_key;
  if v_existing is not null then return v_existing; end if;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    insert into public.contacts (
      name, email, phone, city, state, status_id, browser, ppc_kw, source, ip, utm, created_at
    )
    values (
      coalesce(nullif(v_row->>'name', ''), '(no name)'),
      nullif(v_row->>'email', ''),
      nullif(v_row->>'phone', ''),
      nullif(v_row->>'city', ''),
      nullif(v_row->>'state', ''),
      nullif(v_row->>'status_id', '')::uuid,
      nullif(v_row->>'browser', ''),
      nullif(v_row->>'ppc_kw', ''),
      coalesce(nullif(v_row->>'source', ''), 'import'),
      nullif(v_row->>'ip', ''),
      nullif(v_row->>'utm', ''),
      -- Mapped lead date when present and valid; otherwise the row's insert time.
      coalesce(nullif(v_row->>'created_at', '')::timestamptz, now())
    )
    returning id into v_contact_id;
    v_ids := array_append(v_ids, v_contact_id);

    for v_link in select value from jsonb_array_elements(coalesce(v_row->'links', '[]'::jsonb))
    loop
      insert into public.contact_links (contact_id, position, url, status)
      values (
        v_contact_id,
        (v_link->>'position')::int,
        v_link->>'url',
        coalesce(nullif(v_link->>'status', ''), 'live')
      );
    end loop;

    insert into public.job_queue (kind, payload, dedupe_key)
    values (
      'score_contact',
      jsonb_build_object('contactId', v_contact_id),
      'score:import:' || v_contact_id::text
    )
    on conflict (dedupe_key) do nothing;
  end loop;

  insert into public.import_chunks (request_key, contact_ids, created_by)
  values (p_request_key, v_ids, p_created_by);
  return v_ids;
end;
$$;
revoke all on function public.import_contact_chunk(text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.import_contact_chunk(text, jsonb, uuid) to service_role;
