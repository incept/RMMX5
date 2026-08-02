-- ---------------------------------------------------------------------------
-- Per-account "accept this host's certificate" for IMAP
-- ---------------------------------------------------------------------------
-- Shared mail hosts (e.g. WPX) often present a TLS certificate for the server's
-- own hostname rather than the mail domain. Desktop clients let the user accept
-- that certificate once; Node/imapflow rejects it by default, which shows up as a
-- generic connection failure. This opt-in flag (OFF by default) relaxes cert
-- verification for a single mailbox's IMAP connection — the same exception a user
-- approves in Thunderbird. It is a non-secret setting, so it joins the safe view.

alter table public.email_accounts
  add column if not exists imap_allow_invalid_cert boolean not null default false;

-- Append the new non-secret column to the safe projection (new columns only ever
-- go at the END so `create or replace view` accepts it). Self-contained: the view
-- runs as invoker and authenticated is column-granted every non-secret column,
-- never a password.
create or replace view public.email_accounts_safe as
select
  id, owner_id, name, from_name, from_email, smtp_host, smtp_port,
  smtp_username, smtp_secure, signature_html, is_default, created_at,
  imap_host, imap_port, imap_username, imap_secure, imap_enabled,
  imap_allow_invalid_cert
from public.email_accounts
where public.is_active();

alter view public.email_accounts_safe set (security_invoker = true, security_barrier = true);

revoke all on table public.email_accounts_safe from public, anon;
grant select on table public.email_accounts_safe to authenticated;

grant select (
  id, owner_id, name, from_name, from_email, smtp_host, smtp_port,
  smtp_username, smtp_secure, signature_html, is_default, created_at,
  imap_host, imap_port, imap_username, imap_secure, imap_enabled,
  imap_allow_invalid_cert
) on public.email_accounts to authenticated;
