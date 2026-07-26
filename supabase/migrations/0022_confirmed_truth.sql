-- Human-confirmed truth: facts and links a person has vouched for, which the
-- search must treat as authoritative regardless of where they came from.
--
-- The problem this fixes: search_facts is machine-accumulated and gets wiped by
-- "Clear results", so there was nowhere for a human-verified fact to live
-- permanently, and no way to say "this URL is definitely our person" without
-- spending one of the 14 removal slots.
--
-- Design: ONE authoritative store. confirmed_facts holds the verified fact
-- values; confirming a LINK derives its facts (county, date, middle name from
-- the URL) into the same store, so both origins converge. The link's URL is also
-- recorded as a candidate with status 'confirmed' — kept for display, kept out
-- of the removal slots, and kept in the dedupe set so it never re-surfaces.

-- Authoritative facts, same shape as search_facts but human-vouched. Highest
-- precedence when seeding a run, and NOT touched by "Clear results".
alter table public.contacts
  add column if not exists confirmed_facts jsonb not null default '{}'::jsonb;

comment on column public.contacts.confirmed_facts is
  'Human-confirmed facts (same shape as search_facts). Outrank scraped facts when seeding a run, and survive Clear results. search_facts is machine learning that can be wiped; this is truth that cannot.';

-- 'confirmed' status: a URL a human has vouched for as this person's, held as
-- truth WITHOUT consuming a removal slot. 'manual' source: a URL a human pasted
-- rather than one a probe or SERP returned.
alter table public.search_candidates
  drop constraint if exists search_candidates_status_check;
alter table public.search_candidates
  add constraint search_candidates_status_check
  check (status in ('new', 'accepted', 'rejected', 'confirmed'));

alter table public.search_candidates
  drop constraint if exists search_candidates_source_check;
alter table public.search_candidates
  add constraint search_candidates_source_check
  check (source in ('probe', 'google', 'bing', 'manual'));
