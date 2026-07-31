-- ---------------------------------------------------------------------------
-- Clear the Supabase "Security Definer View" advisor on email_accounts_safe.
-- ---------------------------------------------------------------------------
-- 0027 exposed a non-secret projection of email_accounts to authenticated users
-- through this view, with the base table fully revoked from them. The view was a
-- SECURITY DEFINER view (the Postgres default), so it ran with the owner's
-- rights and bypassed RLS on the base table — which is exactly what Supabase's
-- security advisor flags ("Security Definer View" / the "Unrestricted" badge).
--
-- Fix: run the view as the INVOKER (so RLS applies), and give authenticated the
-- least privilege it needs to read the same safe projection — a COLUMN-level
-- SELECT that omits smtp_password. The password therefore stays unreadable even
-- via a direct PostgREST query on the base table. RLS is already enabled on
-- email_accounts with a `for select using (public.is_active())` policy (0003),
-- so an active session's read passes. The service-role worker path (which reads
-- the full row, including the password, to actually send mail) bypasses RLS and
-- is unaffected. No column the view did not already expose becomes visible.

alter view public.email_accounts_safe set (security_invoker = true);

-- Column-level SELECT: every safe column, and never smtp_password. Column grants
-- are explicit, so any secret column added to email_accounts later is NOT
-- auto-granted — it stays private by default.
grant select (
  id, owner_id, name, from_name, from_email, smtp_host, smtp_port,
  smtp_username, smtp_secure, signature_html, is_default, created_at
) on public.email_accounts to authenticated;
