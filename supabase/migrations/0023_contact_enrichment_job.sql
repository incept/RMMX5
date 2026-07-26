-- A new job kind needs the database constraint widened in the same breath as
-- the TypeScript union, or every enqueue fails with 23514 and — as we learned
-- the hard way with deep_search — leaves no row, no debug entry, and a 500 the
-- operator can only read as "it hangs".
alter table public.job_queue
  drop constraint if exists job_queue_kind_check;
alter table public.job_queue
  add constraint job_queue_kind_check check (
    kind in (
      'auto_search', 'deep_search', 'contact_enrichment', 'email_delivery',
      'sms_delivery', 'voicemail_delivery', 'notification_delivery'
    )
  );
