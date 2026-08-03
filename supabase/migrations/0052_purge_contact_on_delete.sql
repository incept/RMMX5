-- Full erasure when a contact is deleted (product decision: deleting a contact
-- must remove ALL of that person's data — GDPR "right to be forgotten").
--
-- Before this, four child tables were ON DELETE SET NULL, so a plain contact
-- delete left their rows behind with contact_id nulled: the person's email
-- bodies (email_messages), call recordings + transcripts (calls), raw form
-- submissions (webhook_leads), and debug context (debug_log) all survived for
-- months until an unrelated age-based sweep. Two more stores had no contact FK
-- at all: job_queue rows (contact id lives in the payload JSON) and
-- import_chunks.contact_ids (a uuid[] array).
--
-- This migration:
--   1. flips those four foreign keys to ON DELETE CASCADE, and
--   2. rewrites the BEFORE DELETE trigger to DELETE the contact's job_queue rows
--      (not just mark them failed) and strip its id from import batches.
--
-- The children of email_messages (email_events, email_event_buckets) are
-- already ON DELETE CASCADE, so they follow the parent automatically.

-- 1. SET NULL -> CASCADE on the four retained tables. The constraint name is
--    looked up rather than assumed, so this is correct whatever Postgres named
--    it (all four declared the FK inline, so it is <table>_contact_id_fkey, but
--    we don't rely on that).
do $$
declare
  t text;
  c text;
  targets text[] := array['email_messages', 'calls', 'webhook_leads', 'debug_log'];
begin
  foreach t in array targets loop
    select con.conname
      into c
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public'
      and rel.relname = t
      and con.contype = 'f'
      and con.confrelid = 'public.contacts'::regclass
      and (
        select attname
        from pg_attribute
        where attrelid = con.conrelid and attnum = con.conkey[1]
      ) = 'contact_id';
    if c is not null then
      execute format('alter table public.%I drop constraint %I', t, c);
    end if;
    execute format(
      'alter table public.%I add constraint %I foreign key (contact_id) '
      || 'references public.contacts(id) on delete cascade',
      t, t || '_contact_id_fkey'
    );
  end loop;
end $$;

-- 2. The BEFORE DELETE trigger already blocks a delete while a job is
--    processing. Change it to DELETE the contact's remaining queue rows (they
--    carry the contact id — and, for searches, the person's name — with no FK,
--    so nothing else removes them) and drop the contact id from any import
--    batch's uuid[] column.
create or replace function public.cancel_jobs_for_deleted_contact()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Never delete a contact out from under a running job: the worker holds a
  -- lease and expects the row to exist. Block; the operator retries once it ends.
  if exists (
    select 1
    from public.job_queue j
    where j.status = 'processing'
      and (lower(j.payload ->> 'contactId') = old.id::text or old.deep_search_job_id = j.id)
  ) then
    raise exception 'Contact has background work in progress; retry when it finishes';
  end if;

  -- Erase every non-processing job carrying this contact id (payload JSON has no
  -- FK). Was: marked 'failed' and left to linger until the 30-day age sweep.
  delete from public.job_queue j
  where j.status <> 'processing'
    and (lower(j.payload ->> 'contactId') = old.id::text or old.deep_search_job_id = j.id);

  -- Close the pending->processing race: if a row was claimed mid-delete, stop
  -- rather than leave a half-erased contact.
  if exists (
    select 1
    from public.job_queue j
    where j.status = 'processing'
      and (lower(j.payload ->> 'contactId') = old.id::text or old.deep_search_job_id = j.id)
  ) then
    raise exception 'Contact acquired background work during deletion; retry when it finishes';
  end if;

  -- Strip the contact's id from any import batch's uuid[] (array column, no FK).
  update public.import_chunks
  set contact_ids = array_remove(contact_ids, old.id)
  where contact_ids @> array[old.id];

  return old;
end;
$$;
