# RMMX5 — Crisis Management CRM

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
2. In the SQL Editor, run `supabase/migrations/0001_init.sql`, then
   `supabase/migrations/0002_security.sql`, then
   `supabase/migrations/0003_access_and_delivery_hardening.sql`. Together they
   create every table, the storage buckets, seed data, RLS, SMTP ownership
   controls, atomic sequence claiming, and notification/webhook deduplication.
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

## 2. Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000, sign in with the bootstrapped admin, then visit
**Admin → Integrations** to enter your BrightData / Emailit / TextLink / Stripe
keys (they live in the `settings` table with admin-only RLS — not in env vars).

## 3. The cron tick

Sequences and countdown notifications are driven by one idempotent endpoint.
Schedule it every 5–15 minutes (Vercel Cron, hPanel cron, GitHub Actions…):

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://yourdomain.com/api/cron/tick"
```

`CRON_SECRET` comes from `.env.local`.

## 4. Webhooks

Webhook credentials are never placed in URLs:

| Purpose | URL | Authentication |
| --- | --- | --- |
| Fluent Forms lead capture | `POST /api/webhooks/fluent-forms` | `Authorization: Bearer <Fluent Forms secret>` |
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
- **Rate limiting** is not implemented on general authenticated API routes;
  deploy behind a platform/WAF request limit. Upload endpoints do enforce file
  size and active-content restrictions.
- **Password reset** flow isn't wired into a page (Supabase supports it).
- `xlsx` (SheetJS 0.20.3 via the official CDN tarball) parses admin-uploaded
  files only.
