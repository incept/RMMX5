-- ============================================================================
-- RMMX5 — Security hardening (run after 0001; safe to run on live data)
-- ============================================================================

-- 1. SMTP passwords must never be readable from the browser.
--    RLS is row-level only, so use column-level grants: authenticated users
--    can read every email_accounts column EXCEPT smtp_password. The app now
--    treats the password as write-only (sent on create, or on edit only when
--    replaced). Server-side sending uses the service role, which keeps full
--    access.
revoke select on table public.email_accounts from anon, authenticated;
grant select (
  id, owner_id, name, from_name, from_email,
  smtp_host, smtp_port, smtp_username, smtp_secure,
  signature_html, is_default, created_at
) on public.email_accounts to authenticated;

-- 2. Activity log integrity: a user may only write entries as themselves
--    (or anonymously as "system"), not impersonate another actor. Server
--    code uses the service role and is unaffected.
drop policy "activity insert" on public.activity_log;
create policy "activity insert" on public.activity_log for insert
  with check (public.is_active() and (actor_id is null or actor_id = auth.uid()));
