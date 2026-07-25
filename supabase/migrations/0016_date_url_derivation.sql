-- Derive date-keyed pages instead of searching for them.
--
-- northcarolina.arrests.org/Wake/2026/April/22/ is a DAILY COUNTY ROSTER, not a
-- per-person record, and it is indexed by Google. Two consequences:
--
--   * a name search on that host can miss it, because the page is addressed by
--     county and date rather than by the person;
--   * once county, state, and booking date are known, the URL is fully
--     determined — no search, no unlocker, and no policy problem, on a host
--     BrightData refuses to fetch for us.
--
-- The facts needed are exactly the ones the chain already produces: 204 of the
-- 207 historical mugshots.zone links carry a booking date, and every one of them
-- carries the county.
alter table public.probe_sites
  add column if not exists date_url_template text;

comment on column public.probe_sites.date_url_template is
  'Builds a date-addressed page (usually a daily county roster) from known facts. Placeholders: {state_name} {state} {county} {county_slug} {yyyy} {month_name} {mm} {dd}. Derivation needs no request, so it works on hosts we cannot fetch.';

update public.probe_sites
set date_url_template = 'https://{state_name}.arrests.org/{county}/{yyyy}/{month_name}/{dd}/'
where domain = 'arrests.org';
