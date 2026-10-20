# CrewMind

**What this app does:** Multi-tenant SaaS for home services businesses. Homeowners submit job requests via a tenant's quote page (`/q/<slug>`); AI scores each lead, a quote is generated from the tenant's own pricing rules, the customer gets a booking link and a contract to sign online, and a deposit can be collected via Stripe Checkout. Booked work becomes a job: completion triggers the final invoice (balance after deposit, plus customer-approved change orders) and a review bot. Contractors sign up self-serve (14-day trial, founding cohort of 100 at a locked $119 rate), onboard in ≤15 minutes with Google Places prefill, and manage everything in the tenant console (`/app`). The platform operator (tenant 1) keeps the admin console, the prospect scraper, and a CAN-SPAM GTM campaign engine. Core plan: $149/mo monthly or $119/mo annually; caps of 200 AI-qualified leads + 500 scraped prospects per tenant/month with opt-in lead overage.

**Stack:** Node.js + Express 4 + PostgreSQL (Neon) + Google Gemini API (lead qualification) + Resend (email) + Stripe (Checkout deposits, invoice payments, and subscriptions) + Google Places API (onboarding prefill) + Puppeteer (Maps scraper, contract PDFs) + optional R2 upload proxy (lead photos)

**Directory map:**
- `server.js` — Entry point: middleware, route mounts (Stripe webhook is mounted with a raw body parser before the JSON parser), startup migrations + availability slot top-up
- `routes/` — HTTP handlers: `leads.js`, `appointments.js`, `admin.js` (exports `requireAdmin`, used by server-level routes too), `payments.js` (pay-link redirectors + webhook: deposits, invoices, subscriptions), `contracts.js` (public signing API + admin contracts API), `auth.js` (tenant login), `signup.js`, `tenant.js` (tenant console API), `billing.js` (subscription checkout — mounted BEFORE the tenant router so locked tenants can pay), `onboarding.js`, `quote-page.js` (`/q/:slug`), `change-orders.js` (public approval API), `reviews.js` (public feedback API), `gtm.js` (operator prospects/campaigns + public unsubscribe)
- `db/` — All SQL queries: `index.js` (Pool), `tenants.js`, `leads.js`, `quotes.js` (incl. pricing rules + `seedPricingRulesForTenant`), `appointments.js` (incl. slot generation), `settings.js` (per-tenant: PK `(tenant_id, key)`), `scraped-leads.js`, `contracts.js`, `jobs.js` (jobs + job_events), `invoices.js`, `change-orders.js`, `reviews.js`, `usage.js`, `gtm.js`
- `services/` — Business logic: `lead-qualify.js` (AI scoring), `quote-engine.js` (pricing), `email.js` (Resend sends; failures are returned as `{ ok: false }`, never thrown), `payments.js` (Stripe Checkout sessions), `contracts.js` (scope/terms/document generation + signing hash), `billing.js` (Stripe subscriptions + tenant status mapping), `usage.js` (cap policy), `prefill.js` (Google Places onboarding prefill — best-effort, never blocks), `invoicing.js` (final-invoice math + sessions), `change-orders.js` (document text + hash), `reviews.js` (review-bot flow), `campaigns.js` (CAN-SPAM composer/sender), `exports.js` (QuickBooks CSV)
- `lib/` — Infrastructure wrappers: `ai.js` (Gemini `generateContent` client; `chat()` → string), `auth.js` (bcrypt + JWT, `requireTenant`, `blockWritesWhenLocked`), `pricing-defaults.js` (the 12-rule default price book shared by migration 002 and per-tenant seeding)
- `scraperService.js` — Puppeteer Google Maps scraper (browser always closed via finally)
- `migrations/` — Schema migrations run on server startup (tracked in `_migrations`); tenancy is 006, usage 007, jobs/invoices 008, change orders 009, reviews 010, GTM 011
- `public/` — Static HTML: `index.html` (landing), `get-quote.html` (operator intake), `quote-form.html` (tenant quote form served at `/q/:slug`), `book.html` (calendar), `confirm.html` (confirmation), `contract.html` (customer signing page), `change-order.html` (CO approval page), `feedback.html` (private review feedback), `invoice-paid.html`, `signup.html`, `onboard.html` (wizard), `app.html` (tenant console), `admin.html` (operator console incl. GTM pipeline + campaigns)

**Database:**
- `users` — Platform users (subscription management; created at startup)
- `pricing_rules` — Base price + per-sqft rate per job type. Migration 002 seeds nonzero ballpark defaults for all 12 intake job types; editable in the admin console
- `leads` — Inbound job requests with AI score, qualification status, photo URLs
- `quotes` — Auto-generated estimates linked to leads, with line items and payment state (`payment_status`, `amount_paid_cents`, Stripe session/payment-intent ids, `paid_at` — migration 003)
- `appointments` — Booked estimate slots with confirmation codes; `confirmation_sent_at` is set only when the confirmation email actually sends
- `available_slots` — Calendar availability (08:00/10:00/13:00/15:00, max 2 bookings). Topped up automatically at startup for the next 30 business days; regenerable via `POST /api/admin/slots/generate`
- `app_settings` — Key/value settings (migration 003): `deposit_percent` (default 20), `business_name`, `business_address`, `business_phone` — all editable in the admin console
- `scraped_leads` — Persisted scraper results (name, phone, website, query, source), deduped on (name, phone, query). These rows represent prospect businesses found by the scraper — not tied to any single operator's pipeline
- `contracts` — Quote-generated contracts (migration 005): human-readable number (`CM-YYYY-NNNN`), unguessable `access_token` for the public signing page, scope/terms/amount snapshots, status draft → sent → signed (or void), and signing audit fields (signed name, timestamp, IP, user agent, `document_sha256` of the canonical content)
- `tenants` — (migration 006) One row per business: slug, bcrypt `password_hash`, status (`trial`/`active`/`past_due`/`locked`/`canceled`), `is_operator` (tenant 1 = the platform operator; all Phase 1 data lives there), founding cohort fields, trial window, Stripe customer/subscription ids, onboarding + payout flags. Every tenant-owned table carries `tenant_id`; `app_settings` is keyed `(tenant_id, key)`. Trial expiry is computed (`effectiveStatus()`), not stored.
- `jobs` / `job_events` — (migration 008) Work units grown from lead+quote+appointment; every lifecycle event (created, completed, invoice sent/paid, change orders, review flow) is logged in `job_events`.
- `invoices` — (migration 008) Final invoices: `total_cents` (quote + approved COs), `deposit_paid_cents`, `amount_due_cents`, status draft → sent → paid, Stripe session/intent ids, per-tenant number `INV-<tenant>-<id>`.
- `change_orders` — (migration 009) Token-link customer approval with contracts-style signing (SHA-256 of the document); only `approved` rows count toward invoices.
- `review_requests` — (migration 010) One per job: status `pending_prompt` → `sent`/`skipped` → `feedback_submitted`; private feedback text/rating lives here, visible only to the tenant.
- `usage_events` — (migration 007) Metering rows for cap enforcement (`ai_qualified_lead` recorded only for scored, non-disqualified leads; `scraped_prospect` per saved prospect).
- `campaigns` / `campaign_sends` / `email_suppressions` — (migration 011) Operator GTM: campaign drafts, per-recipient send log (unique per campaign+prospect), and the CAN-SPAM suppression list checked before every send. `scraped_leads.pipeline_status` tracks new/contacted/trial/paid/churned.
- `_migrations` — Applied migration tracking

**External integrations:**
- Google Gemini API (`GEMINI_API_KEY`, model `gemini-3.5-flash`, `GEMINI_MODEL` override) — lead qualification scoring
- Resend (`RESEND_API_KEY`, optional `EMAIL_FROM`) — lead acknowledgement, quote + booking link, appointment confirmation, contract link, final invoices, change-order links, review requests + thank-yous, GTM campaigns
- Stripe (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) — Checkout sessions for quote deposits and final invoices; subscriptions for the Core plan (price ids via `STRIPE_PRICE_CORE_*` env). The single webhook at `POST /api/payments/webhook` dispatches: subscription lifecycle → tenant status, invoice sessions → invoice/job paid, quote sessions → quote `deposit_paid`/`paid`. All payment features no-op cleanly when the secret key is unset
- Google Places API (`GOOGLE_PLACES_API_KEY`) — onboarding prefill only; absence or failure never blocks onboarding
- R2 upload proxy (`R2_UPLOAD_URL`, `R2_API_KEY`) — optional photo uploads from the intake form (up to 5 images per lead); leads save without photos when unset
- QuickBooks — **CSV export only** (QBO invoice-import layout + payments register). No OAuth integration; `qbo_realm_id`/`qbo_connected` settings are placeholders for a future sync.

**Security notes:**
- Admin API and both scraper endpoints require `ADMIN_TOKEN` (bearer). If `ADMIN_TOKEN` is unset they fail closed with 503 — there is no unauthenticated mode.
- Tenant console auth is separate from the operator token: bcrypt password + 7-day JWT (`JWT_SECRET`). Every tenant query is scoped by `tenant_id` — cross-tenant reads/writes return 404 (verified by automated isolation tests).
- Locked tenants (expired trial / canceled subscription) keep read access and billing-checkout access; all other writes return 402 `subscription_required`, and public lead intake refuses with 402.
- The public contract/change-order/feedback pages are gated by random access tokens, not ids.
- Signed contracts lock: no edits, and the API refuses to void them.
- GTM outreach is email-only (no SMS to prospects — TCPA); campaign sends require the operator's physical address and honor the suppression list.

**Recent changes:**
- 2026-10 (Phase 2): Multi-tenancy (migration 006, operator = tenant 1), tenant auth, self-serve signup + 14-day trial + founding cohort, Stripe subscriptions driving tenant status, onboarding wizard with Places prefill and `/q/:slug` quote pages, jobs + final invoicing (008), change orders (009), review bot (010), GTM prospect pipeline + CAN-SPAM campaigns (011), usage caps (007: 200 qualified leads / 500 prospects, opt-in overage), QuickBooks CSV export
- 2026-10: Full build-out — admin fail-closed auth + authenticated scraper, Anthropic → Gemini swap, real pricing seeds (migration 002), auto-generated booking slots + fixed booking links (`/book` resolves via static `extensions: ['html']`, production fallback host), real admin console, persisted scraper results, honest email/quote status tracking, Stripe deposit payments (migration 003), and online contracts with e-signature (migration 005)
- 2026-05-06: Built core lead-to-booking engine — intake form, AI qualification, quote generation, calendar booking, email confirmations, admin dashboard with pricing rule editor
