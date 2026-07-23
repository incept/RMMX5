-- ============================================================================
-- RMMX5 — Crisis Management CRM — Initial Schema
--
-- Run this whole file once in the Supabase SQL Editor (or via supabase db push).
-- Creates every table, helper functions, triggers, seed data, and RLS policies.
--
-- Access model:
--   * Everyone must be a logged-in, active profile ("worker" or "admin").
--   * Workers share the CRM: they can see and edit contacts, links, email, etc.
--   * Config tables (statuses, stages, custom fields, URL rules, vendors,
--     notification rules) are readable by all, writable only by admins.
--   * `settings` (API keys) is admin-only and is additionally only ever read
--     server-side with the service-role key.
-- ============================================================================

-- NOTE: no pg_trgm here. Contact search uses plain ILIKE + btree indexes so
-- this schema applies cleanly on Supabase, where the pg_trgm trigram operator
-- class lives in the `extensions` schema and isn't always on the SQL editor's
-- search_path (which fails the migration on the contacts indexes). If contact
-- search gets slow on very large datasets, enable pg_trgm from the Supabase
-- dashboard (Database → Extensions) and add GIN trigram indexes then.

-- ---------------------------------------------------------------------------
-- Profiles & roles
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  phone text,
  role text not null default 'worker' check (role in ('admin', 'worker')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  signature_html text,
  created_at timestamptz not null default now()
);

-- The very first account to register becomes an admin automatically;
-- everyone after that starts as a worker until an admin promotes them.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    case when not exists (select 1 from public.profiles) then 'admin' else 'worker' end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and status = 'active'
  );
$$;

create or replace function public.is_active()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and status = 'active'
  );
$$;

-- Non-admins cannot change their own role/status (privilege escalation guard),
-- even with a direct PostgREST call that bypasses the app's API routes.
create or replace function public.protect_privileged_profile_fields()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    new.role := old.role;
    new.status := old.status;
  end if;
  return new;
end;
$$;

create trigger protect_profile_fields
  before update on public.profiles
  for each row execute function public.protect_privileged_profile_fields();

-- ---------------------------------------------------------------------------
-- Config: statuses, client stages, custom fields
-- ---------------------------------------------------------------------------

create table public.statuses (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  color text not null default '#9CA3AF',
  sort_order int not null default 0,
  is_client_status boolean not null default false,
  created_at timestamptz not null default now()
);

insert into public.statuses (name, color, sort_order, is_client_status) values
  ('New',                  '#3B82F6', 1,  false),
  ('No Link',              '#9CA3AF', 2,  false),
  ('NI Cost',              '#F59E0B', 3,  false),
  ('Bad Email',            '#F43F5E', 4,  false),
  ('Refund',               '#EF4444', 5,  false),
  ('NQ/NI',                '#64748B', 6,  false),
  ('Bounced',              '#F97316', 7,  false),
  ('Recon',                '#8B5CF6', 8,  false),
  ('Removed',              '#14B8A6', 9,  false),
  ('Using Vendor',         '#06B6D4', 10, false),
  ('Pending Service',      '#EAB308', 11, false),
  ('Client',               '#22C55E', 12, true),
  ('Default',              '#A8A29E', 13, false),
  ('Pending Service Cost', '#84CC16', 14, false),
  ('Engagement',           '#D946EF', 15, false),
  ('NI',                   '#78716C', 16, false);

-- Stages a contact moves through once they become a client. Editable by admins.
create table public.stages (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  color text not null default '#6366F1',
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

insert into public.stages (name, color, sort_order) values
  ('Onboarding',          '#6366F1', 1),
  ('Links Requested',     '#0EA5E9', 2),
  ('Removal In Progress', '#F59E0B', 3),
  ('Verification',        '#8B5CF6', 4),
  ('Complete',            '#22C55E', 5);

-- Admin-configurable extra fields, shown on the contact panel under a tab.
create table public.custom_fields (
  id uuid primary key default gen_random_uuid(),
  tab text not null check (tab in ('contact', 'link', 'data', 'email')),
  label text not null,
  field_key text not null unique,
  field_type text not null default 'text' check (field_type in ('text', 'number', 'date', 'select')),
  options jsonb not null default '[]'::jsonb, -- for 'select'
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Vendors & URL rules (link scoring / difficulty / revenue)
-- ---------------------------------------------------------------------------

create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  website text,
  service_page_url text,
  base_cost numeric(10,2),
  notes text,
  created_at timestamptz not null default now()
);

-- One rule per site/domain the admin cares about. Drives:
--   * link scoring         (score_weight — how badly a live link here hurts)
--   * removal difficulty   (difficulty 1–10)
--   * revenue projection   (removal_price — what we charge to remove it)
--   * auto-search filtering (relevant — keep results from this domain)
create table public.url_rules (
  id uuid primary key default gen_random_uuid(),
  pattern text not null unique, -- domain or substring matched against URLs
  name text,
  difficulty int not null default 5 check (difficulty between 1 and 10),
  score_weight numeric(6,2) not null default 10,
  removal_price numeric(10,2) not null default 0,
  relevant boolean not null default true,
  vendor_id uuid references public.vendors (id) on delete set null,
  notes text,
  created_at timestamptz not null default now()
);

-- Which sites each vendor can remove, and what the vendor charges us.
create table public.vendor_capabilities (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors (id) on delete cascade,
  url_rule_id uuid not null references public.url_rules (id) on delete cascade,
  cost numeric(10,2),
  unique (vendor_id, url_rule_id)
);

-- ---------------------------------------------------------------------------
-- Contacts & links
-- ---------------------------------------------------------------------------

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  -- CONTACT INFO tab
  name text not null default '',
  city text,
  state text,
  email text,
  phone text,
  status_id uuid references public.statuses (id) on delete set null,
  -- LINK DATA tab (links themselves live in contact_links)
  reputation_score numeric(5,1), -- 0–100, computed by lib/scoring.ts
  link_score numeric(8,2),       -- sum of live-link weights
  -- DATA tab
  browser text,
  ppc_kw text,
  source text,
  ip text,
  utm text,
  -- client fields
  stage_id uuid references public.stages (id) on delete set null,
  client_since timestamptz,      -- set when status flips to a client status
  service_days int,              -- countdown length in days (null = settings default)
  revenue_projection numeric(10,2),
  -- misc
  custom jsonb not null default '{}'::jsonb, -- values for custom_fields, keyed by field_key
  owner_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index contacts_name_idx on public.contacts (name);
create index contacts_email_idx on public.contacts (email);
create index contacts_status_idx on public.contacts (status_id);
create index contacts_created_idx on public.contacts (created_at desc);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger contacts_touch before update on public.contacts
  for each row execute function public.touch_updated_at();

-- Up to 14 tracked links per contact (positions 1–14), each with its own status.
create table public.contact_links (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete cascade,
  position int not null check (position between 1 and 14),
  url text not null default '',
  status text not null default 'live' check (status in ('live', 'requested', 'removed')),
  url_rule_id uuid references public.url_rules (id) on delete set null,
  difficulty int,
  score_weight numeric(6,2),
  updated_at timestamptz not null default now(),
  unique (contact_id, position)
);

create index contact_links_contact_idx on public.contact_links (contact_id);

-- ---------------------------------------------------------------------------
-- Activity log
-- ---------------------------------------------------------------------------

create table public.activity_log (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.contacts (id) on delete cascade,
  actor_id uuid references public.profiles (id) on delete set null, -- null = system
  type text not null, -- created | updated | status_change | link_change | email | sms | voicemail | note | import | search | file
  description text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index activity_contact_idx on public.activity_log (contact_id, created_at desc);
create index activity_created_idx on public.activity_log (created_at desc);

-- ---------------------------------------------------------------------------
-- Email: accounts (SMTP), templates, lists, sequences, messages, events
-- ---------------------------------------------------------------------------

create table public.email_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.profiles (id) on delete cascade, -- null = shared/team account
  name text not null,
  from_name text not null default '',
  from_email text not null,
  smtp_host text not null,
  smtp_port int not null default 587,
  smtp_username text not null,
  smtp_password text not null,
  smtp_secure boolean not null default false, -- true = TLS on connect (465)
  signature_html text,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.email_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subject text not null default '',
  html text not null default '',
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger email_templates_touch before update on public.email_templates
  for each row execute function public.touch_updated_at();

create table public.email_lists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

create table public.email_list_members (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.email_lists (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  added_at timestamptz not null default now(),
  unique (list_id, contact_id)
);

-- A sequence sends its steps (templates) to a list, spaced by delay_days.
-- start_trigger:  manual | list_added | status_change
-- stop_on:        any of open, click, reply, bounce, status_change
create table public.email_sequences (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  list_id uuid references public.email_lists (id) on delete set null,
  send_account_id uuid references public.email_accounts (id) on delete set null,
  active boolean not null default false,
  start_trigger text not null default 'manual' check (start_trigger in ('manual', 'list_added', 'status_change')),
  start_status_ids uuid[] not null default '{}',
  stop_on text[] not null default '{reply,bounce}', -- open | click | reply | bounce | status_change
  stop_status_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create table public.sequence_steps (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid not null references public.email_sequences (id) on delete cascade,
  step_order int not null,
  template_id uuid references public.email_templates (id) on delete set null,
  delay_days int not null default 1, -- days after the previous step (0 = same day)
  unique (sequence_id, step_order)
);

create table public.sequence_enrollments (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid not null references public.email_sequences (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'completed', 'stopped')),
  current_step int not null default 0, -- last step sent (0 = none yet)
  next_send_at timestamptz,
  stop_reason text,
  enrolled_at timestamptz not null default now(),
  unique (sequence_id, contact_id)
);

create index enrollments_due_idx on public.sequence_enrollments (status, next_send_at);

-- Every email in or out — this powers the unified inbox and analytics.
create table public.email_messages (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.contacts (id) on delete set null,
  account_id uuid references public.email_accounts (id) on delete set null,
  direction text not null check (direction in ('outbound', 'inbound')),
  from_email text not null,
  to_email text not null,
  subject text not null default '',
  html text not null default '',
  message_id text,          -- SMTP Message-ID for reply threading
  in_reply_to text,
  sequence_id uuid references public.email_sequences (id) on delete set null,
  sequence_step_id uuid references public.sequence_steps (id) on delete set null,
  status text not null default 'sent' check (status in ('queued', 'sent', 'failed', 'received')),
  error text,
  open_count int not null default 0,
  click_count int not null default 0,
  replied boolean not null default false,
  bounced boolean not null default false,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index email_messages_contact_idx on public.email_messages (contact_id, created_at desc);
create index email_messages_created_idx on public.email_messages (created_at desc);

create table public.email_events (
  id uuid primary key default gen_random_uuid(),
  message_id uuid references public.email_messages (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete cascade,
  type text not null check (type in ('open', 'click', 'reply', 'bounce')),
  url text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index email_events_contact_idx on public.email_events (contact_id, created_at desc);

-- ---------------------------------------------------------------------------
-- SMS (TextLink) & voicemail drops
-- ---------------------------------------------------------------------------

create table public.sms_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  body text not null default '',
  list_id uuid references public.email_lists (id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'sending', 'sent', 'failed')),
  sent_count int not null default 0,
  failed_count int not null default 0,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.sms_messages (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.sms_campaigns (id) on delete set null,
  contact_id uuid references public.contacts (id) on delete cascade,
  phone text not null,
  body text not null,
  direction text not null default 'outbound' check (direction in ('outbound', 'inbound')),
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  error text,
  created_at timestamptz not null default now()
);

create table public.voicemail_drops (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  audio_path text not null, -- path inside the 'voicemail-audio' storage bucket
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.voicemail_sends (
  id uuid primary key default gen_random_uuid(),
  drop_id uuid not null references public.voicemail_drops (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete cascade,
  phone text not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  error text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Files per client
-- ---------------------------------------------------------------------------

create table public.contact_files (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete cascade,
  name text not null,
  storage_path text not null, -- path inside the 'contact-files' bucket
  size_bytes bigint not null default 0,
  mime_type text,
  uploaded_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index contact_files_contact_idx on public.contact_files (contact_id);

-- ---------------------------------------------------------------------------
-- Settings, notifications, imports, inbound webhooks
-- ---------------------------------------------------------------------------

-- Admin-entered API keys and app config. Keys: brightdata, emailit, textlink,
-- stripe, fluent_forms, search (google search config), proxy, defaults.
create table public.settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- Admin-configurable "notify the client when X happens" rules.
create table public.notification_rules (
  id uuid primary key default gen_random_uuid(),
  event text not null check (event in ('link_status_change', 'status_change', 'client_countdown')),
  enabled boolean not null default true,
  channels text[] not null default '{email}', -- email | sms
  clients_only boolean not null default true,
  -- Message template. Placeholders: {{name}}, {{link}}, {{link_status}},
  -- {{status}}, {{days_left}}
  template text not null default '',
  config jsonb not null default '{}'::jsonb, -- e.g. {"days_before": [7, 1]} for countdown
  created_at timestamptz not null default now()
);

insert into public.notification_rules (event, enabled, channels, clients_only, template, config) values
  ('link_status_change', true, '{email}', true,
   'Update on your case: the link {{link}} is now marked "{{link_status}}".', '{}'),
  ('client_countdown', false, '{email,sms}', true,
   'Reminder: {{days_left}} day(s) left in your current service period.', '{"days_before": [7, 1]}');

create table public.notifications_log (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.contacts (id) on delete cascade,
  rule_id uuid references public.notification_rules (id) on delete set null,
  channel text not null,
  message text not null,
  status text not null default 'sent' check (status in ('sent', 'failed')),
  error text,
  created_at timestamptz not null default now()
);

create table public.imports (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  source text not null default 'monday' check (source in ('monday', 'csv')),
  mapping jsonb not null default '{}'::jsonb,
  total_rows int not null default 0,
  imported_rows int not null default 0,
  status text not null default 'done' check (status in ('done', 'failed')),
  error text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

-- Raw Fluent Forms webhook payloads (kept for debugging/reprocessing).
create table public.webhook_leads (
  id uuid primary key default gen_random_uuid(),
  payload jsonb not null,
  contact_id uuid references public.contacts (id) on delete set null,
  status text not null default 'processed' check (status in ('processed', 'failed')),
  error text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Storage buckets (files + voicemail audio). Kept private; the app reads and
-- writes them server-side with the service-role key and hands out signed URLs.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public) values
  ('contact-files', 'contact-files', false),
  ('voicemail-audio', 'voicemail-audio', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.statuses enable row level security;
alter table public.stages enable row level security;
alter table public.custom_fields enable row level security;
alter table public.vendors enable row level security;
alter table public.url_rules enable row level security;
alter table public.vendor_capabilities enable row level security;
alter table public.contacts enable row level security;
alter table public.contact_links enable row level security;
alter table public.activity_log enable row level security;
alter table public.email_accounts enable row level security;
alter table public.email_templates enable row level security;
alter table public.email_lists enable row level security;
alter table public.email_list_members enable row level security;
alter table public.email_sequences enable row level security;
alter table public.sequence_steps enable row level security;
alter table public.sequence_enrollments enable row level security;
alter table public.email_messages enable row level security;
alter table public.email_events enable row level security;
alter table public.sms_campaigns enable row level security;
alter table public.sms_messages enable row level security;
alter table public.voicemail_drops enable row level security;
alter table public.voicemail_sends enable row level security;
alter table public.contact_files enable row level security;
alter table public.settings enable row level security;
alter table public.notification_rules enable row level security;
alter table public.notifications_log enable row level security;
alter table public.imports enable row level security;
alter table public.webhook_leads enable row level security;

-- Profiles: whole team is visible to active users; edits guarded by trigger.
create policy "profiles select" on public.profiles for select using (public.is_active());
create policy "profiles update self" on public.profiles for update
  using (id = auth.uid() or public.is_admin());

-- Shared CRM data: any active user can read/write.
create policy "contacts select" on public.contacts for select using (public.is_active());
create policy "contacts insert" on public.contacts for insert with check (public.is_active());
create policy "contacts update" on public.contacts for update using (public.is_active());
create policy "contacts delete" on public.contacts for delete using (public.is_admin());

create policy "links all" on public.contact_links for all
  using (public.is_active()) with check (public.is_active());

create policy "activity select" on public.activity_log for select using (public.is_active());
create policy "activity insert" on public.activity_log for insert with check (public.is_active());

create policy "email accounts all" on public.email_accounts for all
  using (public.is_active() and (owner_id is null or owner_id = auth.uid() or public.is_admin()))
  with check (public.is_active());

create policy "templates all" on public.email_templates for all
  using (public.is_active()) with check (public.is_active());
create policy "lists all" on public.email_lists for all
  using (public.is_active()) with check (public.is_active());
create policy "list members all" on public.email_list_members for all
  using (public.is_active()) with check (public.is_active());
create policy "sequences all" on public.email_sequences for all
  using (public.is_active()) with check (public.is_active());
create policy "steps all" on public.sequence_steps for all
  using (public.is_active()) with check (public.is_active());
create policy "enrollments all" on public.sequence_enrollments for all
  using (public.is_active()) with check (public.is_active());
create policy "messages all" on public.email_messages for all
  using (public.is_active()) with check (public.is_active());
create policy "events select" on public.email_events for select using (public.is_active());
create policy "sms campaigns all" on public.sms_campaigns for all
  using (public.is_active()) with check (public.is_active());
create policy "sms messages all" on public.sms_messages for all
  using (public.is_active()) with check (public.is_active());
create policy "vm drops all" on public.voicemail_drops for all
  using (public.is_active()) with check (public.is_active());
create policy "vm sends all" on public.voicemail_sends for all
  using (public.is_active()) with check (public.is_active());
create policy "files select" on public.contact_files for select using (public.is_active());
create policy "notifications log select" on public.notifications_log for select using (public.is_active());
create policy "imports select" on public.imports for select using (public.is_active());
create policy "webhook leads select" on public.webhook_leads for select using (public.is_admin());

-- Config tables: read for everyone active, write for admins only.
create policy "statuses select" on public.statuses for select using (public.is_active());
create policy "statuses write" on public.statuses for all
  using (public.is_admin()) with check (public.is_admin());
create policy "stages select" on public.stages for select using (public.is_active());
create policy "stages write" on public.stages for all
  using (public.is_admin()) with check (public.is_admin());
create policy "custom fields select" on public.custom_fields for select using (public.is_active());
create policy "custom fields write" on public.custom_fields for all
  using (public.is_admin()) with check (public.is_admin());
create policy "vendors select" on public.vendors for select using (public.is_active());
create policy "vendors write" on public.vendors for all
  using (public.is_admin()) with check (public.is_admin());
create policy "url rules select" on public.url_rules for select using (public.is_active());
create policy "url rules write" on public.url_rules for all
  using (public.is_admin()) with check (public.is_admin());
create policy "vendor caps select" on public.vendor_capabilities for select using (public.is_active());
create policy "vendor caps write" on public.vendor_capabilities for all
  using (public.is_admin()) with check (public.is_admin());
create policy "notification rules select" on public.notification_rules for select using (public.is_active());
create policy "notification rules write" on public.notification_rules for all
  using (public.is_admin()) with check (public.is_admin());

-- Settings: admins only (and in practice only touched via service-role server code).
create policy "settings admin" on public.settings for all
  using (public.is_admin()) with check (public.is_admin());
