-- arrests.org comes back on, fetched by real Chrome.
--
-- 0014 turned direct probing off because BrightData refuses the domain by policy
-- (policy_20000). The site itself was never the obstacle. What blocks us is
-- Cloudflare reading the TLS handshake: Node's OpenSSL signature (JA4
-- t13d5212h1, announcing 52 cipher suites) looks nothing like a browser, and no
-- header, proxy, or cipher option changes it. Measured, all 403:
--
--   node direct / node via proxy / curl-from-Linux-equivalent
--   every browser User-Agent tried (Chrome, Safari, Firefox, Edge)
--   Chrome's cipher list, curves, sigalgs, and TLS1.2 pinning
--
-- Real Chrome negotiates through BoringSSL and is simply served:
--
--   headless + browser UA                  200  Wake County Arrest report April, 22 2026
--   headless + UA + stealth                200
--   headless + UA + stealth + proxy        200
--   headed (control)                       200
--   headless with DEFAULT UA               403  <- "HeadlessChrome" in the UA string
--
-- So the browser tier is the route, and overriding the User-Agent is the part
-- that makes it work at all.
alter table public.probe_sites
  add column if not exists needs_browser boolean not null default false;

comment on column public.probe_sites.needs_browser is
  'Fetch this host with real Chrome, skipping the plain and proxied HTTP tiers. For sites that fingerprint the TLS handshake (Cloudflare JA3/JA4), where those tiers fail every time and cost two 20s attempts each.';

update public.probe_sites
set active = true,
    needs_browser = true,
    notes = 'Fetched with real Chrome: Cloudflare blocks on the TLS fingerprint, which no Node-side option changes, but BoringSSL passes (roster, record and search.php all verified 200 headless). BrightData still refuses the domain by policy, so the unlocker is not a fallback here. 20.5% of historical client links.'
where domain = 'arrests.org';

-- SERP discovery stays on for now. Browser probing is new, and until it has a
-- few real runs behind it the search index is worth keeping as a second route to
-- the biggest source of client links. Turn it off once the tier has proven
-- itself and reclaim the fallback slot:
--   update public.probe_sites set serp_fallback = false where domain = 'arrests.org';

-- The daily roster is a browser fetch too: same host, same Cloudflare rule.
-- (date_url_template was set in 0016; this just records that it is reachable.)
