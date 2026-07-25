-- SERP fallback slots are scarce (each costs a request), so they have to go to
-- the sites that actually carry client records.
--
-- What went wrong without this: fallback domains were ordered by scope, so
-- 'national' sorted ahead of 'state' and arre.st — a 19-link short-link mirror
-- of arrests.org — consumed a slot while arrests.org itself, 20.5% of every
-- historical client link, was cut off by the per-run cap.
alter table public.probe_sites
  add column if not exists priority int not null default 100;

comment on column public.probe_sites.priority is
  'Lower runs first when SERP fallback slots are limited. Set from how often a site actually appears in client records, not from how the site is scoped.';

-- Ranked by share of the 1,049 historical client links.
update public.probe_sites set priority = 10 where domain = 'arrests.org';          -- 20.5%
update public.probe_sites set priority = 15 where domain = 'mugshots.zone';        -- 19.7%
update public.probe_sites set priority = 20 where domain = 'bustednewspaper.com';  -- 15.7%
update public.probe_sites set priority = 25 where domain = 'recentlybooked.com';   -- 11.6%
update public.probe_sites set priority = 40
where domain in ('wakencbusts.com', 'wakepublicrecords.com');

-- arre.st is arrests.org's short-link form: the same records under /{ST}-{id}/.
-- Searching both spends two requests to find one set of records, and the
-- site:arre.st query returned no organic results at all. Discovery goes through
-- arrests.org; arre.st stays registered so its URLs still parse when they turn
-- up elsewhere.
update public.probe_sites
set serp_fallback = false,
    priority = 200,
    notes = 'Short-link form of arrests.org records (/{ST}-{id}/). Not searched separately: it mirrors arrests.org, and site:arre.st returned nothing. Kept registered so its URLs still parse when found via other routes.'
where domain = 'arre.st';
