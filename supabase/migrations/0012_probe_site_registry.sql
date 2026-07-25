-- Probe registry seeded from 1,049 historical client links plus the operator
-- networks identified in-house.
--
-- What the historical data showed: four domains account for 68% of every link
-- ever attached to a client (arrests.org 215, mugshots.zone 207,
-- bustednewspaper.com 165, recentlybooked.com 122 — all already active), social
-- accounts for 9.4% (Facebook 83, Instagram 14, X 2), and the remaining ~22% is
-- a long tail of 100+ domains.
--
-- Rows whose SEARCH path has not been confirmed are inserted inactive: an
-- inactive row is a to-do item, an active one is a promise that the probe works.

-- Network N3: mugshots.zone and Busted Newspaper are the same operator, and
-- bustednewspaper has a .org sibling alongside the .com already seeded.
update public.probe_sites set family = 'bustednewspaper-mugshotszone'
where domain in ('mugshots.zone', 'bustednewspaper.com');

insert into public.probe_sites (domain, name, search_template, scope, family, active, notes)
values
  ('bustednewspaper.org', 'Busted Newspaper (.org)',
   'https://bustednewspaper.org/search/{name}/', 'national',
   'bustednewspaper-mugshotszone', false,
   'Sibling of bustednewspaper.com (N3). Search path assumed to mirror the .com — verify before enabling.'),
  -- arre.st is arrests.org''s short domain: /{ST}-{numeric id}/ record URLs.
  ('arre.st', 'Arre.st (arrests.org short links)',
   'https://arre.st/search.php?fname={first}&lname={last}&fpartial=True', 'national',
   'arrests-org', false,
   'Short-link form of arrests.org records (/{ST}-{id}/). 19 historical links. Search path UNVERIFIED.')
on conflict (domain) do nothing;

update public.probe_sites set family = 'arrests-org' where domain = 'arrests.org';

-- Network N1: one operator running {county}publicrecords.com per county, so the
-- domain itself is derivable from a county we already know — the same trick that
-- makes mugshots.zone probeable. Confirmed instances: palmbeach, broward,
-- orange, wake. Registered under the bare family domain because the county slug
-- belongs in the template, not in 50 near-duplicate rows.
insert into public.probe_sites (domain, name, search_template, scope, family, active, notes)
values
  ('publicrecords.com', 'County Public Records network (N1)',
   'https://{county_slug}publicrecords.com/?s={name}', 'county', 'county-publicrecords', false,
   'Derivable per county: palmbeach/broward/orange/wake publicrecords.com all confirmed in client history. Records are sample.php?id=N and share ids with the wake*busts sites. Search path UNVERIFIED.')
on conflict (domain) do nothing;

-- Network N2: one operator, ad-hoc domain names per county/city, so each has to
-- be listed. All Florida except albuquerquebusted (NM) and mugshotsathens (GA).
insert into public.probe_sites (domain, name, search_template, scope, scope_state, family, active, notes)
values
  ('pascocountyarrests.com', 'Pasco County Arrests', 'https://pascocountyarrests.com/?s={name}', 'county', 'FL', 'n2-local-busts', false, 'N2 network. Search path UNVERIFIED.'),
  ('mugshotslakecounty.com', 'Mugshots Lake County', 'https://mugshotslakecounty.com/?s={name}', 'county', 'FL', 'n2-local-busts', false, 'N2 network. Search path UNVERIFIED.'),
  ('mugshotsathens.com', 'Mugshots Athens', 'https://mugshotsathens.com/?s={name}', 'county', 'GA', 'n2-local-busts', false, 'N2 network. Search path UNVERIFIED.'),
  ('mugshotsleecounty.com', 'Mugshots Lee County', 'https://mugshotsleecounty.com/?s={name}', 'county', 'FL', 'n2-local-busts', false, 'N2 network. Search path UNVERIFIED.'),
  ('mugshotssarasota.com', 'Mugshots Sarasota', 'https://mugshotssarasota.com/?s={name}', 'county', 'FL', 'n2-local-busts', false, 'N2 network. 2 historical links. Search path UNVERIFIED.'),
  ('tbcrimes.com', 'TB Crimes', 'https://tbcrimes.com/?s={name}', 'county', 'FL', 'n2-local-busts', false, 'N2 network. 7 historical links. Search path UNVERIFIED.'),
  ('marionmugshots.com', 'Marion Mugshots', 'https://marionmugshots.com/?s={name}', 'county', 'FL', 'n2-local-busts', false, 'N2 network. Search path UNVERIFIED.'),
  ('daytonamugshot.com', 'Daytona Mugshot', 'https://daytonamugshot.com/?s={name}', 'county', 'FL', 'n2-local-busts', false, 'N2 network. Search path UNVERIFIED.'),
  ('mugshotsbradenton.com', 'Mugshots Bradenton', 'https://mugshotsbradenton.com/?s={name}', 'county', 'FL', 'n2-local-busts', false, 'N2 network. Search path UNVERIFIED.'),
  ('polkbusted.com', 'Polk Busted', 'https://polkbusted.com/?s={name}', 'county', 'FL', 'n2-local-busts', false, 'N2 network. Search path UNVERIFIED.'),
  ('mugshotsorlando.com', 'Mugshots Orlando', 'https://mugshotsorlando.com/?s={name}', 'county', 'FL', 'n2-local-busts', false, 'N2 network. 3 historical links. Search path UNVERIFIED.'),
  ('citruscountybusted.com', 'Citrus County Busted', 'https://citruscountybusted.com/?s={name}', 'county', 'FL', 'n2-local-busts', false, 'N2 network. Search path UNVERIFIED.'),
  ('collierarrests.com', 'Collier Arrests', 'https://collierarrests.com/?s={name}', 'county', 'FL', 'n2-local-busts', false, 'N2 network. Search path UNVERIFIED.'),
  ('mugshotsosceola.com', 'Mugshots Osceola', 'https://mugshotsosceola.com/?s={name}', 'county', 'FL', 'n2-local-busts', false, 'N2 network. Search path UNVERIFIED.'),
  ('albuquerquebusted.com', 'Albuquerque Busted', 'https://albuquerquebusted.com/?s={name}', 'county', 'NM', 'n2-local-busts', false, 'N2 network. Search path UNVERIFIED.')
on conflict (domain) do nothing;

-- Long tail worth probing, ranked by how often it appeared in client history.
-- Unaffiliated with the networks above as far as we know. All inactive pending
-- a confirmed search path; ?s= is WordPress's default and a reasonable first
-- guess for most of them.
insert into public.probe_sites (domain, name, search_template, scope, scope_state, active, notes)
values
  ('thegeorgiagazette.com', 'The Georgia Gazette', 'https://thegeorgiagazette.com/?s={name}', 'state', 'GA', false, '16 historical links. Search path UNVERIFIED.'),
  ('tampabusts.com', 'Tampa Busts', 'https://tampabusts.com/?s={name}', 'county', 'FL', false, '9 historical links. Search path UNVERIFIED.'),
  ('palmbeachbusts.com', 'Palm Beach Busts', 'https://palmbeachbusts.com/?s={name}', 'county', 'FL', false, '8 historical links. Search path UNVERIFIED.'),
  ('crimeinformer.com', 'Crime Informer', 'https://crimeinformer.com/?s={name}', 'national', null, false, '8 historical links. Search path UNVERIFIED.'),
  ('jailrecords.info', 'Jail Records', 'https://jailrecords.info/?s={name}', 'national', null, false, '7 historical links. Search path UNVERIFIED.'),
  ('bustedinwakecounty.com', 'Busted in Wake County', 'https://bustedinwakecounty.com/?s={name}', 'county', 'NC', false, '6 historical links. Search path UNVERIFIED.'),
  ('arrestfiles.org', 'Arrest Files', 'https://arrestfiles.org/?s={name}', 'national', null, false, '6 historical links. Search path UNVERIFIED.'),
  ('mugshots.com', 'Mugshots.com', 'https://mugshots.com/search.html?q={name}', 'national', null, false, '5 historical links. Search path UNVERIFIED.'),
  ('southfloridarecords.com', 'South Florida Records', 'https://southfloridarecords.com/?s={name}', 'county', 'FL', false, '4 historical links. Search path UNVERIFIED.'),
  ('arrestfacts.com', 'Arrest Facts', 'https://arrestfacts.com/?s={name}', 'national', null, false, '4 historical links. Search path UNVERIFIED.'),
  ('mecklenburgcountybusts.com', 'Mecklenburg County Busts', 'https://mecklenburgcountybusts.com/?s={name}', 'county', 'NC', false, '3 historical links. Search path UNVERIFIED.'),
  ('palmbeachcountymugshots.com', 'Palm Beach County Mugshots', 'https://palmbeachcountymugshots.com/?s={name}', 'county', 'FL', false, '2 historical links. Search path UNVERIFIED.'),
  ('tricountybusts.com', 'Tri-County Busts', 'https://tricountybusts.com/?s={name}', 'county', null, false, '2 historical links. Search path UNVERIFIED.'),
  ('wakecountyncmugshots.com', 'Wake County NC Mugshots', 'https://wakecountyncmugshots.com/?s={name}', 'county', 'NC', false, '2 historical links. Search path UNVERIFIED.'),
  ('bustedncmugshots.com', 'Busted NC Mugshots', 'https://bustedncmugshots.com/?s={name}', 'state', 'NC', false, '2 historical links. Search path UNVERIFIED.')
on conflict (domain) do nothing;

-- Note on what is deliberately absent: news outlets (miamiherald, wccbcharlotte,
-- spacecoastdaily, bocanewsnow and similar), court/legal aggregators (trellis.law,
-- unicourt), and people-search aggregators (radaris, jailbase) all appear in
-- client history but have no arrest-record search worth probing. News and social
-- coverage is caught instead by the SERP classifier, which is what the 9.4% of
-- historical Facebook/Instagram/X links needs.
