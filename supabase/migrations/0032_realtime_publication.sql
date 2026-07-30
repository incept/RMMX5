-- Near-live UI refresh. Stream row changes on the tables the main views read,
-- so the dashboard, contacts grid, clients list, and inbox update within a few
-- seconds of a change without a manual reload. This only turns on the change
-- FEED — the browser subscribes, debounces, and refetches through the same
-- RLS-checked queries it already uses. RLS still governs which changes each
-- subscriber receives: a worker never sees a change to a row it cannot select.
--
-- Idempotent: adding a table already in the publication errors, so each is
-- guarded. The supabase_realtime publication is created by Supabase; guarded
-- too in case a migration runs against a bare database.
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach t in array array['contacts', 'activity_log', 'email_messages'] loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
