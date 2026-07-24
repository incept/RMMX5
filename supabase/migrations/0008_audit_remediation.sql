-- ============================================================================
-- RMMX5 — Audit remediation
-- Run after 0007_search_flag.sql.
-- ============================================================================

-- Exact, case-insensitive webhook identity matching without ILIKE wildcards.
alter table public.contacts
  add column if not exists email_normalized text
  generated always as (lower(btrim(email))) stored;

create index if not exists contacts_email_normalized_idx
  on public.contacts (email_normalized)
  where email_normalized is not null;

alter table public.contacts
  add column if not exists phone_normalized text
  generated always as (right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)) stored;

create index if not exists contacts_phone_normalized_idx
  on public.contacts (phone_normalized)
  where phone_normalized <> '';

-- A call row is an idempotency record, not proof that every side effect
-- completed. Pending/leased state lets a retry reclaim interrupted work.
alter table public.calls
  add column if not exists processing_status text not null default 'pending',
  add column if not exists processing_started_at timestamptz,
  add column if not exists processed_at timestamptz,
  add column if not exists processing_error text;

alter table public.calls
  drop constraint if exists calls_processing_status_check;
alter table public.calls
  add constraint calls_processing_status_check
  check (processing_status in ('pending', 'processing', 'completed'));

update public.calls
set processing_status = 'completed',
    processed_at = coalesce(processed_at, created_at)
where processing_status = 'pending'
  and (contact_id is not null or ai_category in ('spam', 'wrong_number'));

create index if not exists calls_processing_idx
  on public.calls (processing_status, processing_started_at)
  where processing_status <> 'completed';

-- Retry metadata for notification reservations. A failed reservation can be
-- reclaimed after backoff instead of being blocked forever by its unique key.
alter table public.notifications_log
  add column if not exists attempt_count int not null default 0,
  add column if not exists next_retry_at timestamptz;

-- Stable request/delivery keys bound the blast endpoints and make an HTTP retry
-- return the prior result instead of charging the provider a second time.
alter table public.email_messages add column if not exists delivery_key text;
create unique index if not exists email_messages_delivery_key_idx
  on public.email_messages (delivery_key) where delivery_key is not null;

alter table public.sms_campaigns add column if not exists request_key text;
create unique index if not exists sms_campaigns_request_key_idx
  on public.sms_campaigns (request_key) where request_key is not null;

alter table public.sms_messages add column if not exists delivery_key text;
create unique index if not exists sms_messages_delivery_key_idx
  on public.sms_messages (delivery_key) where delivery_key is not null;

alter table public.voicemail_sends add column if not exists delivery_key text;
create unique index if not exists voicemail_sends_delivery_key_idx
  on public.voicemail_sends (delivery_key) where delivery_key is not null;
