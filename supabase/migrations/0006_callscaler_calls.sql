-- ============================================================================
-- RMMX5 — CallScaler call tracking
-- Run after 0005_debug_log.sql.
--
-- Inbound calls become first-class records. The post-call webhook (and the
-- cron backfill) writes one row per call; when the caller matches an existing
-- contact (phone digits or gclid) the call is linked, otherwise a new contact
-- is created — so "called but never filled out the form" leads stop being
-- invisible to the CRM.
-- ============================================================================

create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  call_id text not null unique,   -- CallScaler's id; the idempotency key for
                                  -- both the webhook and the cron backfill
  contact_id uuid references public.contacts (id) on delete set null,
  direction text,                 -- inbound / outbound
  status text,                    -- completed / no-answer / voicemail / busy / failed
  caller_number text,
  caller_name text,               -- CNAM lookup; often junk ("WIRELESS CALLER")
  tracking_number text,
  duration_seconds int,
  recording_url text,
  transcription text,
  summary text,
  ai_score int,                   -- 0–100
  ai_category text,               -- lead / existing_customer / spam / wrong_number / voicemail
  qualified_ai boolean,
  source text,                    -- traffic attribution from CallScaler
  raw jsonb not null default '{}'::jsonb,  -- full payload, for fields we did not lift
  started_at timestamptz,         -- CallScaler's created_at for the call
  created_at timestamptz not null default now()
);

create index if not exists calls_contact_idx on public.calls (contact_id, started_at desc);
create index if not exists calls_created_idx on public.calls (created_at desc);

alter table public.calls enable row level security;

-- Readable by any active user (same as contacts); written only by server code
-- with the service role, so there are no insert/update policies.
drop policy if exists "calls select" on public.calls;
create policy "calls select" on public.calls for select using (public.is_active());

drop policy if exists "calls delete" on public.calls;
create policy "calls delete" on public.calls for delete using (public.is_admin());

-- gclid is the join key between a form fill and a phone call from the same ad
-- click: CallScaler captures it per call and Fluent Forms can post it with the
-- submission, so an exact match means the same person even when the CNAM name
-- and the form name disagree.
alter table public.contacts
  add column if not exists gclid text;

create index if not exists contacts_gclid_idx on public.contacts (gclid) where gclid is not null;
