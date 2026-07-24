-- ============================================================================
-- RMMX5 — Contact intake metadata
-- Run after 0003_access_and_delivery_hardening.sql.
--
-- Fluent Forms attaches a block of default metadata to every submission
-- (User IP, Source URL, Browser, Device, User, Submitted On). IP and Browser
-- already had columns; these are the rest, so a lead keeps its full
-- provenance instead of losing it in the raw webhook payload.
-- ============================================================================

alter table public.contacts
  add column if not exists device text,        -- "Windows", "iPhone", …
  add column if not exists source_url text,    -- page the form was submitted from
  add column if not exists wp_user text,       -- logged-in WordPress user, if any
  add column if not exists submitted_at timestamptz; -- form's own timestamp

comment on column public.contacts.source_url is
  'Page URL the lead submitted the form from (Fluent Forms "Source URL").';
comment on column public.contacts.submitted_at is
  'Timestamp reported by the form itself; created_at is when the CRM stored it.';
