-- ---------------------------------------------------------------------------
-- IMAP receiving config on email accounts (Phase 1 of the read-write IMAP inbox)
-- ---------------------------------------------------------------------------
-- Adds the connection fields for pulling/syncing mail from a real IMAP mailbox
-- (e.g. WPX hosting). Sending still goes through SMTP / Emailit; these are for
-- receiving. imap_password is a secret and is handled exactly like smtp_password:
-- service-role only, never in the safe view, never column-granted to a browser
-- session. Per-folder sync state (UIDVALIDITY / last UID) lands in Phase 2.

alter table public.email_accounts
  add column if not exists imap_host text,
  add column if not exists imap_port int not null default 993,
  add column if not exists imap_username text,
  add column if not exists imap_password text,
  add column if not exists imap_secure boolean not null default true,  -- 993 = implicit TLS
  add column if not exists imap_enabled boolean not null default false;

-- Re-expose the safe projection with the non-secret IMAP fields appended (new
-- columns are only ever added at the END so `create or replace view` accepts it).
-- Stated in full and self-contained w.r.t. 0042's security_invoker change, so it
-- is correct whether or not 0042 has been applied: the view runs as the invoker
-- (RLS applies) and authenticated is column-granted every non-secret column —
-- never smtp_password or imap_password.
create or replace view public.email_accounts_safe as
select
  id, owner_id, name, from_name, from_email, smtp_host, smtp_port,
  smtp_username, smtp_secure, signature_html, is_default, created_at,
  imap_host, imap_port, imap_username, imap_secure, imap_enabled
from public.email_accounts
where public.is_active();

alter view public.email_accounts_safe set (security_invoker = true, security_barrier = true);

revoke all on table public.email_accounts_safe from public, anon;
grant select on table public.email_accounts_safe to authenticated;

grant select (
  id, owner_id, name, from_name, from_email, smtp_host, smtp_port,
  smtp_username, smtp_secure, signature_html, is_default, created_at,
  imap_host, imap_port, imap_username, imap_secure, imap_enabled
) on public.email_accounts to authenticated;
