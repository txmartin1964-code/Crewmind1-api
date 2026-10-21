# CrewMind

AI-powered lead-to-booking engine for home services businesses: intake form → AI lead qualification → instant quote → online contract signing → deposit payment → estimate appointment booking, plus an admin console and a prospect scraper.

**Phase 2 — CrewMind is now multi-tenant SaaS.** Contractors sign up for a 14-day free trial, onboard in under 15 minutes, and run their own business (leads, pricing, jobs, invoices, reviews) in a tenant console at their own quote URL (`/q/<their-slug>`). The platform operator (CrewMind itself) keeps the admin console, the prospect scraper, and a GTM campaign engine for selling trials. One plan: **Core — $149/mo monthly or $119/mo billed annually**; the first 100 tenants (founding cohort) lock $119/mo for 12 months.

## Requirements

- Node.js 18+
- PostgreSQL database (Neon recommended)

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string. The server refuses to boot without it. |
| `PORT` | no | Server port (default: 3000). |
| `GEMINI_API_KEY` | for AI scoring | Free key from [Google AI Studio](https://aistudio.google.com/apikey). Without it, leads fall back to manual review. |
| `GEMINI_MODEL` | no | Gemini model override (default: `gemini-3.5-flash`). |
| `RESEND_API_KEY` | for email | From [resend.com](https://resend.com/api-keys) (free tier: 3,000 emails/month). Without it, sends fail visibly in logs and nothing is falsely marked as sent. |
| `EMAIL_FROM` | no | Sender identity, e.g. `CrewMind <quotes@yourdomain.com>`. Defaults to Resend's onboarding address (testing only — verify a domain in Resend for production). |
| `ADMIN_TOKEN` | for admin | Bearer token for the admin console/API and scraper endpoints. If unset, those routes return 503 (fail closed) — there is no unauthenticated admin mode. |
| `APP_URL` | no | Public base URL of this deployment (default: `https://crewmind1-api.onrender.com`). Used for booking, payment, and contract links in emails. |
| `STRIPE_SECRET_KEY` | for payments | From the Stripe dashboard. Without it, all payment features hide/no-op and the rest of the app works normally. |
| `STRIPE_WEBHOOK_SECRET` | for payments | Signing secret for the webhook endpoint. Register `https://crewmind1-api.onrender.com/api/payments/webhook` in Stripe for `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, and `invoice.payment_failed`. |
| `R2_UPLOAD_URL`, `R2_API_KEY` | no | Photo upload target for intake-form photos. Leads save without photos when unset. |
| `JWT_SECRET` | for tenant logins | Signs tenant session tokens. If unset, a random secret is generated per boot (all tenant sessions reset on restart) — set it in production. |
| `STRIPE_PRICE_CORE_MONTHLY` | for subscriptions | Stripe Price ID for Core at $149/mo billed monthly. |
| `STRIPE_PRICE_CORE_ANNUAL` | for subscriptions | Stripe Price ID for Core at $119/mo billed annually. |
| `STRIPE_PRICE_CORE_FOUNDING` | no | Stripe Price ID for the founding-cohort $119/mo lock. When set, founding tenants are always charged this price; otherwise they use the interval price above. |
| `GOOGLE_PLACES_API_KEY` | no | Enables onboarding prefill from the business's public Google listing (address/phone/hours). Without it, onboarding is manual-entry only — it never blocks. (`GOOGLE_MAPS_API_KEY` / `GOOGLE_API_KEY` also accepted.) |
| `UNSUBSCRIBE_SECRET` | no | HMAC key for campaign unsubscribe links. Falls back to `JWT_SECRET`, then `ADMIN_TOKEN`. |

Settings that change at runtime live in the `app_settings` table **per tenant** (deposit percent default 20%, business name/address/phone, notification contacts, service area, hours, Google review link, lead-overage opt-in/cap, QuickBooks placeholder fields) and are edited in the tenant console; the operator's own settings are edited in the admin console.

## Plans, trials, and caps

- **Signup** (`/signup`) creates a tenant in `trial` status for 14 days — no card. The first 100 signups are the founding cohort (cohort number stored on the tenant).
- **Trial expiry locks the account**: console goes read-only, public quote intake refuses new leads, and billing stays reachable so the tenant can subscribe to unlock. Subscription webhooks drive status: `active` / `past_due` / `locked`.
- **Included monthly allowances per tenant**: 200 AI-qualified leads and 500 scraped prospects. A lead counts only when the AI scores it and does **not** disqualify it — spam/disqualified leads never count and are never charged. Past 200, tenants may opt in to overage ($10–15/lead) with their own monthly ceiling; prospects are hard-capped at 500.
- **Payouts**: job deposits and invoice balances currently settle through the platform Stripe account and are recorded per tenant/job. Per-tenant Stripe Connect payouts are offered during onboarding as a step tenants may skip (a reminder flag stays on their console); true Connect onboarding is a later phase.
- **Lifetime comps (operator-only)**: the operator can grant any tenant a free-forever comp from the admin console's **Tenants** section ("Grant lifetime" / "Revoke comp" buttons; API: `GET /api/admin/tenants`, `POST /api/admin/tenants/:id/comp`, `POST /api/admin/tenants/:id/uncomp`). The comp is an **overlay**, not a status: `tenants.is_comped` / `comped_at` (migration 012) make `effectiveStatus()` report `active` regardless of the stored status or trial clock, and granting/revoking **never rewrites the stored status** — revoke cleanly restores whatever the tenant's trial/subscription state says. Stripe subscription events still record bookkeeping for a comped tenant but can never move their status, and billing checkout politely declines with a "lifetime comp" message instead of creating a session. Usage caps still apply in full (200 AI-qualified leads + 500 prospects/mo) — a comp is free, not unlimited. `/api/admin/stats` reports lead-pipeline counts only (no paying-customer count exists there), so comped tenants are excluded from revenue simply by never entering Stripe billing.

## QuickBooks

**Export now, OAuth sync later.** Each tenant can download QuickBooks-importable CSVs from their console (or the API): `GET /api/tenant/exports/quickbooks/invoices.csv` (QBO invoice-import layout) and `GET /api/tenant/exports/quickbooks/payments.csv` (deposits + invoice payments actually received). A full QuickBooks Online OAuth connection is **not** built — the settings fields `qbo_realm_id` / `qbo_connected` are placeholders reserved for that future sync.

## Endpoints

Public / customer:
- `GET /` — landing page
- `GET /health` — health check
- `POST /api/leads` — submit a lead (multipart, up to 5 photos)
- `GET /api/leads/:id/status` — lead status polling for the thank-you page
- `GET /api/appointments/slots?from&to` — available booking slots
- `POST /api/appointments/book` — book a slot
- `GET /api/appointments/confirm/:code` — appointment lookup by confirmation code
- `GET /api/payments/link/:quoteId` — redirects to Stripe Checkout for the quote's deposit
- `POST /api/payments/webhook` — Stripe webhook (raw body, signature verified)
- `GET /contract.html?c=<token>` — customer contract view + signing page
- `GET /api/contracts/view/:token`, `GET /api/contracts/document/:token`, `POST /api/contracts/view/:token/sign` — signing page API

Tenants (signup/login at `/signup` and `/app`; onboarding wizard at `/onboard`):
- `POST /api/signup` — create a tenant (trial, founding cohort when applicable); `POST /api/auth/login` — tenant login (bcrypt + JWT)
- `GET /q/:slug` — a tenant's public, branded quote page (the form posts to `/api/leads` with the tenant slug)
- `GET /api/onboarding/prefill`, `GET /api/onboarding/status`, `POST /api/onboarding/complete` — the ≤15-minute setup wizard
- `GET /api/tenant/me`, `/leads`, `/appointments`, `/contracts`, `/jobs`, `/invoices`, `/reviews`, `/usage` — the tenant console API (JWT; every query tenant-scoped; writes return 402 while the tenant is locked)
- `POST /api/tenant/jobs/:id/complete` — mark a job complete (fires the review prompt)
- `POST /api/tenant/jobs/:id/invoice` — create/send the final invoice (balance = quote total + approved change orders − deposit paid)
- `POST /api/tenant/jobs/:id/change-orders`, public approval at `GET/POST /api/change-orders/view/:token[/sign|/decline]` and `/change-order.html?c=<token>` — customer e-signs; only approved change orders bill
- `POST /api/tenant/jobs/:id/review` / `/review/skip` — review bot: emails the customer "Share on Google" + "Tell us privately" (`/feedback.html?t=<token>`, `POST /api/reviews/feedback/:token`) side by side
- `GET /api/payments/invoice-link/:invoiceId` — stable pay link for a final invoice (redirects to Stripe)
- `GET /api/tenant/billing/status`, `POST /api/tenant/billing/checkout` — subscription status/checkout (reachable even while locked)
- `GET /api/tenant/exports/quickbooks/invoices.csv`, `GET /api/tenant/exports/quickbooks/payments.csv` — QuickBooks CSV export
- `POST /api/tenant/scrape` — tenant prospect search (metered against the 500/month allowance)

Operator GTM (in the admin console):
- `GET /api/admin/prospects`, `PATCH /api/admin/prospects/:id` — prospect pipeline over `scraped_leads` (new → contacted → trial → paid/churned; a signup with a matching email auto-moves a prospect to `trial`)
- `GET/POST /api/admin/campaigns`, `POST /api/admin/campaigns/:id/send` — CAN-SPAM email campaigns: honest subject, physical-address footer (send refuses until the operator address is set), signed one-click unsubscribe, per-campaign send log, suppression list honored. Trial links carry the campaign tag (`/signup?c=cmp-<id>`). **Email only — no SMS to prospects (TCPA).**
- `GET/POST /api/admin/suppressions`, public `GET/POST /api/gtm/unsubscribe?e=&s=`

Admin (all require `Authorization: Bearer <ADMIN_TOKEN>`; console at `/admin.html`):
- `GET /api/admin/tenants`, `POST /api/admin/tenants/:id/comp`, `POST /api/admin/tenants/:id/uncomp` — tenant list (stored + effective status, comp state, cohort) and lifetime-comp grant/revoke
- `GET /api/admin/stats`, `GET /api/admin/leads`, `GET /api/admin/appointments`
- `GET /api/admin/pricing`, `PATCH /api/admin/pricing/:id`
- `GET /api/admin/settings`, `PATCH /api/admin/settings`
- `POST /api/admin/slots/generate` — top up booking availability
- `GET /api/admin/contracts`, `GET /api/admin/contracts/:id`, `POST /api/admin/contracts` (create from quote), `POST /api/admin/contracts/:id/send`, `POST /api/admin/contracts/:id/void`, `GET /api/admin/contracts/:id/document`, `GET /api/admin/contracts/:id/pdf`
- `POST /api/admin/scrape-buyers`, `POST /api/client/scrape-leads` — Google Maps scraper (results persist to `scraped_leads`)

## Local Development

```bash
npm install
DATABASE_URL="postgresql://..." npm start
```

Then open http://localhost:3000 (intake at `/get-quote.html`, admin console at `/admin.html`). Migrations and the availability slot top-up run automatically at startup. There is no separate dev script or seed step.

## Deployment

Configured for Render via `render.yaml` (build: `npm install`, start: `npm start`, health check: `/health`). Set the environment variables above in the Render dashboard. Pushing to `main` auto-deploys.
