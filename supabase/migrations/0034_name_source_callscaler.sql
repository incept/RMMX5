-- Two origins for a machine-supplied contact name, each with its own UI marker:
--
--   'callscaler'     → the caller-ID name CallScaler handed us on an inbound
--                      call (green phone marker; stamped at intake)
--   'reverse_lookup' → a name an admin filled with the Trestle reverse lookup
--                      (yellow phone marker; written by lib/enrichment.ts)
--
-- Both are phone-derived leads to verify, not confirmed truth. The existing
-- clear_name_source_on_rename trigger (0030) already clears either value the
-- moment a human edits the name, so no trigger change is needed here.
comment on column public.contacts.name_source is
  'Origin of a machine-supplied contact name. ''callscaler'' = CallScaler caller ID; ''reverse_lookup'' = Trestle reverse phone lookup. Null when a human typed the name or it arrived on a form. Cleared on manual rename.';

-- Backfill names that predate the 'callscaler' marker. A contact whose current
-- name is exactly the caller_name of one of its calls got that name from
-- CallScaler's caller ID at intake: the intake only uses caller_name as the
-- contact name when it looks like a real person, otherwise it writes the
-- placeholder 'Caller <number>', which never equals caller_name. Guarded to
-- rows with no marker yet, so it never overwrites a reverse_lookup mark or a
-- human-verified name, and is safe to re-run.
update public.contacts c
set name_source = 'callscaler'
where c.name_source is null
  and exists (
    select 1
    from public.calls cl
    where cl.contact_id = c.id
      and cl.caller_name is not null
      and btrim(cl.caller_name) = c.name
  );
