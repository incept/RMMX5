-- Renumbered from 0020, which collided with 0020_runtime_hardening.sql — the two
-- were written in parallel and merged from different branches. Filename sort
-- happened to apply them in a safe order, but a tool tracking migrations by
-- numeric prefix could have skipped one, and a skipped migration is exactly what
-- made deep search look like a hung button. Safe to re-run under the new name:
-- the statement below is idempotent.

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
