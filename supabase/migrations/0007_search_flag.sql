-- Flags a contact whose automatic search could not complete, so it can be found
-- and re-run by hand. Set by runAutoSearchForContact in two cases:
--   * the lead had no location to search with (form gave none AND the IP did not
--     geolocate — e.g. ip-api rate limit), so the search was skipped; or
--   * a search engine (Google and/or Bing) failed, so the results are partial or
--     absent.
-- Cleared automatically on the next fully successful search. The text is a short
-- human-readable reason shown in the grid tooltip and the Link Data banner.
alter table public.contacts
  add column if not exists search_flag text,
  add column if not exists search_flagged_at timestamptz;

-- Partial index: the "flagged only" grid filter and any re-run sweep only ever
-- touch the flagged minority, so the index stays tiny.
create index if not exists contacts_search_flag_idx
  on public.contacts (search_flagged_at desc)
  where search_flag is not null;
