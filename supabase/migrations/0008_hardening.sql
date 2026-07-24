-- Hardening batch: atomic tracking counters + retention pruning.

-- Atomic open/click counting. The routes previously did a read-then-write
-- (select open_count, update open_count + 1), which loses counts under
-- concurrent hits. This does the increment in one statement and hands back
-- contact_id so the route can log the event without a second read.
-- SECURITY DEFINER is not needed — only the service_role client calls it.
create or replace function public.track_email_event(p_message_id uuid, p_event text)
returns table (message_id uuid, contact_id uuid)
language sql
as $$
  update public.email_messages m
  set
    open_count  = m.open_count  + (case when p_event = 'open'  then 1 else 0 end),
    click_count = m.click_count + (case when p_event = 'click' then 1 else 0 end)
  where m.id = p_message_id
    and p_event in ('open', 'click')
  returning m.id, m.contact_id;
$$;

revoke all on function public.track_email_event(uuid, text) from anon, authenticated;

-- Retention: webhook_receipts and webhook_leads grew forever. Receipts only
-- exist to dedupe provider retries, which stop within minutes — 30 days is
-- generous. Raw lead payloads are kept longer (90 days) since they are the
-- audit trail for mapping bugs. Called by the cron tick alongside
-- prune_debug_log; returns counts for the tick's response.
create or replace function public.prune_webhook_tables(
  p_receipt_keep_days int default 30,
  p_lead_keep_days int default 90
)
returns table (receipts_deleted int, leads_deleted int)
language plpgsql
as $$
declare
  v_receipts int;
  v_leads int;
begin
  delete from public.webhook_receipts
  where received_at < now() - make_interval(days => p_receipt_keep_days);
  get diagnostics v_receipts = row_count;

  delete from public.webhook_leads
  where created_at < now() - make_interval(days => p_lead_keep_days);
  get diagnostics v_leads = row_count;

  return query select v_receipts, v_leads;
end;
$$;

revoke all on function public.prune_webhook_tables(int, int) from anon, authenticated;
