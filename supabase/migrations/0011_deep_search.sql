-- Deep search, phase 1: probe known mugshot sites' own search pages before
-- spending any SERP requests.
--
-- Why probe first: a site's own index is fresher than Google's crawl of it, a
-- page fetch costs a fraction of a SERP request, and one probe usually yields
-- the middle name and county — the facts that make every later query good.

-- Sites whose on-site search we can drive directly. Deliberately SEPARATE from
-- url_rules: that table drives relevance, difficulty, and removal pricing, and
-- adding rows there to make a site probeable would silently change link scores
-- and revenue projections. Probing and scoring stay independent.
create table if not exists public.probe_sites (
  id uuid primary key default gen_random_uuid(),
  domain text not null unique,
  name text,
  -- Placeholders: {name} {first} {middle} {last} {county} {county_slug} {state}
  -- {state_lower} {state_name} {from_date} {to_date}. Substituted URL-encoded,
  -- spaces as '+'. A template with a placeholder we cannot fill yet is skipped
  -- for that round rather than probed with blanks.
  search_template text not null,
  -- How wide the site's coverage is, which decides WHEN it can be probed:
  -- national = round A (no facts needed); state = round A once the lead's state
  -- is known (IP geolocation gives us that); county = round B, only after a
  -- round-A probe told us the county.
  scope text not null default 'national' check (scope in ('national', 'state', 'county')),
  scope_state text,   -- restrict to one state, e.g. 'NC' (null = any)
  scope_county text,  -- restrict to one county, e.g. 'Wake' (null = any)
  family text,        -- sibling network; siblings often share record ids
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);

alter table public.probe_sites enable row level security;
create policy "probe sites select" on public.probe_sites for select using (public.is_active());
create policy "probe sites write" on public.probe_sites for all
  using (public.is_admin()) with check (public.is_admin());

-- Facts learned about a contact while searching: middle names, county, booking
-- dates, record ids, charges. Values are always ARRAYS because sources
-- disagree — wakencbusts spells it "Micheal", mugshots.zone "Michael" — and
-- both spellings have to stay searchable. Shape:
--   { middle: ["Micheal","Michael"], county: ["Wake"], state: ["NC"],
--     booking_dates: ["2026-04-22"], record_ids: ["140252"], charges: [...] }
alter table public.contacts
  add column if not exists search_facts jsonb not null default '{}'::jsonb;

-- Found URLs awaiting human review. Candidates rather than auto-filled link
-- slots: the matching logic has to earn trust first, and provenance is what
-- makes that auditable. Also unbounded, unlike the 14 link slots.
create table if not exists public.search_candidates (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete cascade,
  url text not null,
  canonical_url text not null, -- scheme/www/trailing-slash stripped, for dedupe
  title text,
  snippet text,
  source text not null check (source in ('probe', 'google', 'bing')),
  source_detail text,          -- domain probed, or the query that found it
  round int not null default 0,
  -- 0..1 corroboration: surname plus how many independent facts line up.
  -- Guards against attaching another John Smith's record to a client.
  confidence numeric(4, 2) not null default 0,
  matched_facts jsonb not null default '{}'::jsonb,
  url_rule_id uuid references public.url_rules (id) on delete set null,
  status text not null default 'new' check (status in ('new', 'accepted', 'rejected')),
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (contact_id, canonical_url)
);

create index if not exists search_candidates_contact_idx
  on public.search_candidates (contact_id, status, confidence desc);

alter table public.search_candidates enable row level security;
create policy "candidates select" on public.search_candidates for select using (public.is_active());
create policy "candidates update" on public.search_candidates for update
  using (public.is_active()) with check (public.is_active());
create policy "candidates delete" on public.search_candidates for delete using (public.is_admin());
-- No insert policy: rows come from the server (service role) only.

-- Seeded from search URLs confirmed by hand. These four cover roughly 80-90%
-- of clients. Sites whose search path is NOT verified are inserted inactive,
-- so nobody assumes a probe is running when it is really 404ing; regional
-- sites get added the same way as they are discovered.
insert into public.probe_sites (domain, name, search_template, scope, family, active, notes)
values
  ('bustednewspaper.com', 'Busted Newspaper',
   'https://bustednewspaper.com/search/{name}/', 'national', 'bustednewspaper', true,
   'Verified. National, so corroborate the state before trusting a hit.'),
  ('arrests.org', 'Arrests.org',
   'https://{state_name}.arrests.org/search.php?fname={first}&lname={last}&fpartial=True',
   'state', null, true,
   'Verified. State subdomain plus structured name params; fpartial=True allows partial first names. Record URLs are /{County}/{yyyy}/{Month}/{dd}/.')
on conflict (domain) do nothing;

-- County-scoped: only probeable once a round-A hit supplies the county, which
-- is exactly the chaining this feature automates.
insert into public.probe_sites
  (domain, name, search_template, scope, scope_state, family, active, notes)
values
  ('mugshots.zone', 'Mugshots Zone',
   'https://{county_slug}{state_lower}.mugshots.zone/?s={name}', 'county', null,
   'mugshots-zone', true,
   'Verified via wakenc.mugshots.zone/?s=Gene+Beachak. County subdomain, so the county must be known first.'),
  ('recentlybooked.com', 'Recently Booked',
   'https://recentlybooked.com/search?StateCode={state}&CountySlug={county_slug}&Gender=&Name={name}&Charge=&FromDate={from_date}&ToDate={to_date}&SortBy=date&SortDirection=desc',
   'county', null, null, true,
   'Verified. Needs state, county, and a date window, so it runs in round B on facts learned in round A. Record URLs are /{state}/{county}/{name}~{id}.'),
  ('wakencbusts.com', 'Wake NC Busts',
   'https://www.wakencbusts.com/?s={name}', 'county', 'NC', 'wake-nc-records', false,
   'Wake County only. Records are view-full-profile.php?id=N, sharing ids with wakepublicrecords.com. Search path UNVERIFIED.'),
  ('wakepublicrecords.com', 'Wake Public Records',
   'https://www.wakepublicrecords.com/?s={name}', 'county', 'NC', 'wake-nc-records', false,
   'Wake County only. sample.php?id=N shares ids with wakencbusts.com. Search path UNVERIFIED.')
on conflict (domain) do nothing;
