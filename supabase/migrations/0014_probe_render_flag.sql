-- BrightData's troubleshooting for a partially-loaded page is render: true (JS
-- rendering). It is per-site because rendering is slower and only some targets
-- need it, so it stays off unless a site is known to require it.
alter table public.probe_sites
  add column if not exists needs_render boolean not null default false;

comment on column public.probe_sites.needs_render is
  'Ask Web Unlocker to render JavaScript for this target (render: true). Slower, so enable only for sites that return an incomplete page without it.';

-- arrests.org is classified and refused at policy level (policy_20000:
-- "classified as <category> and blocked by Bright Data"). That is a standing
-- decision about the domain, not a connectivity problem, so the unlocker will
-- never serve it and every attempt is wasted time. Discovery for this host goes
-- through the SERP fallback, which BrightData's own guidance points to for
-- targets Web Unlocker will not take.
update public.probe_sites
set active = false,
    serp_fallback = true,
    notes = 'Verified search path (state subdomain + fname/lname/fpartial), but BrightData refuses the domain by policy (policy_20000), so direct probing is off and discovery runs through site: SERP search. 20.5% of historical client links. Re-enable active if their compliance team allows the domain.'
where domain = 'arrests.org';
