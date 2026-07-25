-- Per-contact email engagement, for the sent/opens/clicks columns on the
-- contacts grid. Aggregating in the database keeps the page from pulling every
-- email_messages row into the browser just to count them.
--
-- security_invoker = true so the querying user's own RLS applies (the
-- "messages all" policy on email_messages requires is_active()); without it the
-- view would run as its owner and hand data to anyone.
create or replace view public.contact_email_stats
with (security_invoker = true) as
select
  m.contact_id,
  count(*) filter (where m.direction = 'outbound' and m.status = 'sent')::int as sent,
  coalesce(sum(m.open_count), 0)::int as opens,
  coalesce(sum(m.click_count), 0)::int as clicks
from public.email_messages m
where m.contact_id is not null
group by m.contact_id;

grant select on public.contact_email_stats to authenticated;
