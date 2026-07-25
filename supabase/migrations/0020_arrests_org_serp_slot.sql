-- Reclaim the SERP fallback slot arrests.org was holding.
--
-- 0019 left SERP discovery switched on for it as a second route while browser
-- probing was unproven. It has since been confirmed working against the live
-- site, so the site: queries are now buying a result we already have.
--
-- Two things this recovers. Every fallback domain costs two SERP requests (one
-- per engine) on every run, and the per-run fallback count is capped at four —
-- so this both stops the spend and frees the top slot for the next site by
-- share of client links.
--
-- Reverting is one statement, if browser probing ever needs the safety net back:
--   update public.probe_sites set serp_fallback = true where domain = 'arrests.org';
update public.probe_sites
set serp_fallback = false
where domain = 'arrests.org';
