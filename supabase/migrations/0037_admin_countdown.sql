-- Admin-facing client countdown. A separate notification rule that alerts chosen
-- team members when a client nears the end of their service period, in parallel
-- with the existing client-facing client_countdown rule (which is untouched).
--
-- Recipients are specific users, stored as auth user ids in
-- config.recipient_user_ids; delivery is email and/or SMS to each user's own
-- profile (SMS is skipped for a recipient with no phone on file).

alter table public.notification_rules
  drop constraint notification_rules_event_check;
alter table public.notification_rules
  add constraint notification_rules_event_check
  check (event in (
    'link_status_change',
    'status_change',
    'client_countdown',
    'client_countdown_admin'
  ));

-- Seed one disabled admin rule (idempotent) so it shows up as its own card in
-- Admin -> Notifications, ready to enable and assign recipients to.
insert into public.notification_rules (event, enabled, channels, clients_only, template, config)
select
  'client_countdown_admin',
  false,
  '{email,sms}',
  false,
  'Client {{name}} has {{days_left}} day(s) left in their service period.',
  '{"days_before": [7, 1], "recipient_user_ids": []}'::jsonb
where not exists (
  select 1 from public.notification_rules where event = 'client_countdown_admin'
);
