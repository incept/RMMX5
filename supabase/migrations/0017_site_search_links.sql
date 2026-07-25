-- The search page is the view worth opening by hand: a record page proves one
-- booking, while the site's own search shows whether the person has MORE.
--
-- arrests.org's template drops fpartial=True. Both forms were checked against
-- each other and return the same results, and this template is now only used to
-- build a link for a human to click — the domain is policy-blocked, so we never
-- fetch it ourselves. A short URL is the better handoff.
update public.probe_sites
set search_template = 'https://{state_name}.arrests.org/search.php?fname={first}&lname={last}'
where domain = 'arrests.org';
