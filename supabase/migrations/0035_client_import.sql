-- Client import: bring an existing client roster (a grouped spreadsheet: one
-- client, then that client's removal-target URLs beneath it) into the CRM as
-- clients with their Link Data.
--
-- Two new contact fields the client roster tracks that the CRM did not:
--   gross_revenue — money actually collected from the client (distinct from
--                   revenue_projection, which stays a per-URL estimate for
--                   ordinary contacts; gross_revenue is intended to be fed from
--                   Stripe later).
--   signed_date   — the date the client signed on. Display only: it deliberately
--                   does NOT start the service countdown (client_since), so an
--                   imported historical client is not shown as long overdue. The
--                   countdown is started by hand from the contact panel.
alter table public.contacts
  add column if not exists gross_revenue numeric(10, 2),
  add column if not exists signed_date date;

comment on column public.contacts.gross_revenue is
  'Revenue actually collected from a client (client roster / Stripe). Distinct from revenue_projection, which is a per-URL estimate for ordinary contacts.';
comment on column public.contacts.signed_date is
  'Date a client signed on. Display only — does not start the service countdown (that is client_since).';

-- Imports one chunk of clients idempotently, mirroring import_contact_chunk but
-- for the client shape: sets the client status, gross_revenue and signed_date,
-- and inserts each client's already-positioned removal links. Re-running with the
-- same request key returns the ids from the first run instead of duplicating.
create or replace function public.import_client_chunk(
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
      name, phone, email, state, source, status_id, gross_revenue, signed_date
    )
    values (
      coalesce(nullif(v_row->>'name', ''), '(no name)'),
      nullif(v_row->>'phone', ''),
      nullif(v_row->>'email', ''),
      nullif(v_row->>'state', ''),
      coalesce(nullif(v_row->>'source', ''), 'client import'),
      nullif(v_row->>'status_id', '')::uuid,
      nullif(v_row->>'gross_revenue', '')::numeric,
      nullif(v_row->>'signed_date', '')::date
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
      'score:client-import:' || v_contact_id::text
    )
    on conflict (dedupe_key) do nothing;
  end loop;

  insert into public.import_chunks (request_key, contact_ids, created_by)
  values (p_request_key, v_ids, p_created_by);
  return v_ids;
end;
$$;

revoke all on function public.import_client_chunk(text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.import_client_chunk(text, jsonb, uuid) to service_role;
