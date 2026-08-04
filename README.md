# RMMX5 
Next.js 16 (App Router) + Supabase CRM for crisis/reputation management:
a spreadsheet-fast contact grid with colored statuses, per-contact link
tracking (14 slots) with a **Reputation Score** (ported from the ContextAI /
Reputation Monitor scoring engine), Monday.com import, unified inbox with
multi-account SMTP, email sequences with start/stop triggers, SMS campaigns,
voicemail drops, vendor management, revenue projection, and a full admin panel.

## Feature map

| Area | Where |
| --- | --- |
| Spreadsheet contacts grid (search / filter / sort / inline status) | `/contacts` |
| Contact panel — Contact Info, Link Data, Email, Data (+ Activity, Files) tabs | click any row |
| Custom fields per tab (admin-configured) | Admin → Custom Fields |
| Reputation Score + Link Score + revenue projection | `lib/scoring.ts`, shown on grid/panel/dashboard |
| Monday.com / CSV import with column mapping | `/import` |
| Activity log | per-contact Activity tab + dashboard feed |
| Unified inbox, multi-account SMTP, signatures | `/inbox` (⚙ icon manages accounts) |
| Email templates / lists / sequences (delays + triggers) / analytics | `/marketing` |
| Sequence stop triggers: open, click, reply, bounce, status change | sequence editor |
| SMS campaigns (TextLink) | `/sms` |
| Voicemail drops (provider-agnostic ringless VM) | `/voicemail` |
| Clients: editable stages, service countdown (days), files | `/clients` |
| Vendors: costs, service page, sites they can remove | `/vendors` |
| Lead statuses (16 seeded, colored) & client stages | Admin → Statuses & Stages |
| URL rules: link scoring weights, difficulty, removal price, relevance | Admin → URL Rules |
| Client notifications (link status change / status change / countdown) | Admin → Notifications |
| API keys: BrightData, Emailit, TextLink, Stripe, Fluent Forms, voicemail | Admin → Integrations |
| Fluent Forms lead webhook → auto Google search → link scoring | `/api/webhooks/fluent-forms` |
| Backconnect rotating proxy (BrightData) for manual searches | Admin → Integrations |
| Stripe revenue reporting | dashboard |

## 1. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Apply **every** migration in `supabase/migrations` in filename order
   from `0001_init.sql` through the highest-numbered migration shipped with
   the checkout (currently `0054_pr100_117_audit_hardening.sql`). With the
   Supabase CLI, run `supabase db push`; otherwise run each unapplied file in
   the SQL Editor. Apply migrations **before** deploying matching application
   code. The later migrations contain required security, queue, email/IMAP,
   usage-metering, and concurrency controls and are not optional. The cron
   response reports `schema.ok=false` and returns a degraded status when the
   database schema is behind the code's required version, so migration drift is
   visible instead of silently disabling a job lane.
3. Copy the Project URL and API keys into `.env.local` (start from
   `.env.local.example`). Mind the key types: the **publishable** key
   (`sb_publishable_…`, or legacy `anon`) goes in
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`; the **secret** key (`sb_secret_…`, or
   legacy `service_role`) goes in `SUPABASE_SERVICE_ROLE_KEY` only. Putting a
   secret key in the `NEXT_PUBLIC_` var makes every page fail with
   *"Forbidden use of secret API key in browser"*. After editing
   `.env.local`, restart `npm run dev` — `NEXT_PUBLIC_*` values are baked in
   at build time.
4. In Supabase Dashboard → Authentication → Users, create the initial account.
   The database deliberately creates every new Auth identity as a **disabled
   worker**. In the SQL Editor, bootstrap that one trusted account:

   ```sql
   update public.profiles
   set role = 'admin', status = 'active'
   where email = 'owner@your-company.example';
   ```

   Sign in with that account, then create all later users under Admin → Users.
   Keep public Supabase signups disabled; even if they are accidentally enabled,
   the database will not activate or promote those identities.
5. Add `https://yourdomain.com/auth/reset-password` (and the localhost
   equivalent for development) to Authentication → URL Configuration →
   Redirect URLs. Password-reset requests deliberately return the same message
   for known and unknown addresses.
6. For production, enable MFA for administrator accounts in Supabase Auth and
   enforce it through your organization or identity-provider policy.

## 2. Run locally

Use Node.js **22.19.0 or newer**. The pinned `undici` runtime requires that
minimum Node version; older Node releases may install successfully and then
fail at build time or during outbound network requests.

```bash
node --version
npm install
npm run dev
```

Open http://localhost:3000, sign in with the bootstrapped admin, then visit
**Admin → Integrations** to enter your BrightData / Emailit / TextLink / Stripe
keys (they live in the `settings` table with admin-only RLS — not in env vars).

## 3. The cron tick

Sequences, countdown notifications, CallScaler backfill, and the bounded
delivery queue are driven by one idempotent endpoint.
Schedule it every 5–15 minutes (Vercel Cron, hPanel cron, GitHub Actions…):

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://yourdomain.com/api/cron/tick"
```

`CRON_SECRET` comes from `.env.local`.

On Hostinger/hPanel, keep the Next.js app running as the managed Node
application and configure cron to run only the `curl` command above. Do not
start `npm run start` from cron: every invocation would create another idle
Node process. The endpoint uses an atomic database lease, claims one provider
job per tick, renews the job lease while it runs, and safely retries interrupted
jobs. Manual and deep searches are admin-only and enqueue durable work instead
of holding an HTTP worker open.

If Hostinger reports many idle processes, first verify hPanel has only one
managed Node application and only one cron entry. Then inspect `job_queue` for
stale `processing` rows and `debug_log` for `job:*` lease warnings. Do not add
more cron invocations to make a backlog drain faster; shorten the schedule
within the recommended range or move workers to a dedicated process tier.

The browser probe tier temporarily launches Chromium with `--no-sandbox` and
`--disable-setuid-sandbox` for compatibility while the deployment environment
is being verified. Treat this as a temporary high-risk configuration: isolate
the browser worker where possible, keep it non-root, and remove both flags as
soon as the host's Chromium sandbox has been confirmed. Never expose an
unsandboxed browser worker to the CRM's service-role credentials.

Migration `0024_comprehensive_hardening.sql` promotes the oldest active
administrator to the protected `super_admin` installation owner. That account
cannot be disabled, demoted, or deleted. Admin → Debug Log also contains the
retention controls for purging bounded historical datasets and file-storage
objects by age.

## 4. Webhooks

Webhook credentials are never placed in URLs:

| Purpose | URL | Authentication |
| --- | --- | --- |
| Fluent Forms lead capture | `POST /api/webhooks/fluent-forms` | `Authorization: Bearer <Fluent Forms secret>` |
| CallScaler post-call intake | `POST /api/webhooks/callscaler` | `X-RMMX-Webhook-Secret: <CallScaler secret>` |
| Inbound email → inbox/reply detection | `POST /api/webhooks/inbound-email` | `Authorization: Bearer <inbound-email secret>` |
| Emailit bounce/complaint events | `POST /api/webhooks/emailit` | Emailit's `X-Emailit-Signature` + `X-Emailit-Timestamp` |

Configure separate values under Admin → Integrations. Fluent Forms supports
custom request headers; send a stable `X-RMMX-Idempotency-Key` as well when an
entry/submission ID is available. Copy Emailit's `whsec_…` signing secret into
the Emailit section. Signed provider event IDs are deduplicated across retries.

The Fluent Forms feed should send the form fields (name/email/phone/city/
state) plus tracking fields (ip, browser/user_agent, utm_source, utm_term…).
On arrival the app creates the contact, runs the BrightData Google search for
the lead's name, keeps results whose domain matches a **relevant** URL rule,
fills link slots 1–14, and computes the Reputation Score.

## 5. How scoring works

- Every **live** link is matched against Admin → URL Rules (substring match on
  the domain). Matched links contribute the rule's `score_weight`; unmatched
  live links contribute 10. Negative-sentiment titles/snippets add +5
  (lexicon ported from ContextAI).
- `reputation_score = clamp(100 − link_score, 0, 100)` — removals raise it.
- `revenue_projection = Σ removal_price` of matched live links.
- Rules also carry `difficulty` (1–10, shown as D-badges) and an optional
  vendor.

## 6. Email delivery notes

- Outbound mail prefers the selected/default **SMTP account** (nodemailer);
  with none configured it falls back to the **Emailit API** key.
- Every outbound email gets an open-tracking pixel and click-tracked links
  (`/api/track/open`, `/api/track/click`) and is logged to the unified inbox.
- Reply detection relies on the inbound-email webhook (point Emailit inbound
  routing or any forwarder at it). True IMAP polling is intentionally out of
  scope.

## 7. What's stubbed / worth hardening

- **Voicemail drops** POST to a configurable provider endpoint — wire it to
  your ringless-VM vendor's real API shape.
- **TextLink** requires a paired Android device with an active SIM (see their
  docs); if the device is offline, sends fail.
- General authenticated API routes should still sit behind a platform/WAF
  request limit. Cost-bearing list email, SMS, and voicemail sends are
  admin-only, capped at 100 recipients, require idempotency keys, and are
  drained through the bounded queue. JSON, webhook, and upload bodies are
  bounded in the application even when a client omits `Content-Length`.
- Upload endpoints enforce size, extension, MIME, and magic-byte checks. For
  defense in depth, keep the storage buckets private and attach Supabase's
  malware-scanning/quarantine workflow (or an equivalent scanner) before files
  are made available to staff.
- Configure the probe proxy only with a public hostname or IP. Loopback,
  link-local, and private-network destinations are rejected to prevent the
  setting from becoming an SSRF path.
- Usage accounting covers BrightData SERP/unlocker requests and Anthropic
  tokens. Reconcile the estimates against provider invoices; the dashboard is
  operational metering, not the billing system of record.
- `xlsx` (SheetJS 0.20.3 via the official CDN tarball) parses admin-uploaded
  files only.
