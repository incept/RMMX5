-- Two ways to reach records a direct probe cannot.
--
-- 1. SERP fallback. arrests.org answers a datacentre IP with a Cloudflare
--    challenge, and no amount of retrying changes that. But Google has already
--    crawled it, so a site-restricted query ( site:northcarolina.arrests.org
--    "Gene Beachak" ) reaches the same records without touching the site. It
--    costs one SERP request, which is why it runs only where it is needed.
--
-- 2. Record-id pivots. Sibling sites in one network share record ids:
--    wakencbusts.com/view-full-profile.php?id=140252 and
--    wakepublicrecords.com/sample.php?id=140252 are the same booking. Once any
--    sibling yields an id, the others are addressable with no lookup at all —
--    the cheapest discovery available.

alter table public.probe_sites
  -- Search this domain through the SERP API when a direct probe is blocked, or
  -- always, for sites known to refuse us.
  add column if not exists serp_fallback boolean not null default false,
  -- Builds a record URL from a known id. Placeholder: {record_id}.
  add column if not exists record_url_template text;

-- arrests.org is 20.5% of all historical client links and the single most
-- important site to reach; it is also reliably challenge-walled.
update public.probe_sites
set serp_fallback = true
where domain in ('arrests.org', 'bustednewspaper.com', 'arre.st');

-- The Wake network: search paths still unverified, so direct probing stays off,
-- but SERP can find them and their shared ids make the siblings free.
update public.probe_sites
set serp_fallback = true,
    record_url_template = 'https://www.wakencbusts.com/view-full-profile.php?id={record_id}',
    notes = 'Wake County. Record ids are shared with wakepublicrecords.com (confirmed: id=140252 is the same booking on both). Direct search path UNVERIFIED, so discovery goes through SERP; siblings come from the id pivot.'
where domain = 'wakencbusts.com';

update public.probe_sites
set serp_fallback = true,
    record_url_template = 'https://www.wakepublicrecords.com/sample.php?id={record_id}',
    notes = 'Wake County. Shares record ids with wakencbusts.com. Direct search path UNVERIFIED; found via the id pivot or SERP.'
where domain = 'wakepublicrecords.com';

-- N1 is the same operator per county, so one template covers every county once
-- the county is known. Left without serp_fallback: the family pivot reaches it
-- for free, and 50 counties of SERP queries would not be worth it.
update public.probe_sites
set record_url_template = 'https://{county_slug}publicrecords.com/sample.php?id={record_id}'
where domain = 'publicrecords.com';

comment on column public.probe_sites.serp_fallback is
  'Search this domain via site:-restricted SERP when a direct probe is blocked. Costs one SERP request per attempt.';
comment on column public.probe_sites.record_url_template is
  'Builds a record URL from a known id ({record_id}, plus {county_slug} for per-county networks). Used to pivot from one sibling record to the rest of its network.';
