# CrewMind

**What this app does:** AI-powered lead qualification, quoting, booking, deposit payments, and e-signed contracts for home services businesses. Homeowners submit job requests via the intake form; AI scores each lead, a quote is generated from configurable pricing rules, the customer gets a booking link and a contract to sign online, and a deposit can be collected via Stripe Checkout. An authenticated admin console manages leads, pricing, availability, settings, contracts, and a Google Maps scraper that finds prospect businesses.

**Stack:** Node.js + Express 4 + PostgreSQL (Neon) + Google Gemini API (lead qualification) + Resend (email) + Stripe Checkout (deposits) + Puppeteer (Maps scraper, contract PDFs) + optional R2 upload proxy (lead photos)

**Directory map:**
- `server.js` — Entry point: middleware, route mounts (Stripe webhook is mounted with a raw body parser before the JSON parser), startup migrations + availability slot top-up
- `routes/` — HTTP handlers: `leads.js`, `appointments.js`, `admin.js` (exports `requireAdmin`, used by server-level routes too), `payments.js` (pay-link redirector + webhook), `contracts.js` (public signing API + admin contracts API)
- `db/` — All SQL queries: `index.js` (Pool), `leads.js`, `quotes.js`, `appointments.js` (incl. slot generation), `settings.js`, `scraped-leads.js`, `contracts.js`
- `services/` — Business logic: `lead-qualify.js` (AI scoring), `quote-engine.js` (pricing), `email.js` (Resend sends; failures are returned as `{ ok: false }`, never thrown), `payments.js` (Stripe Checkout sessions), `contracts.js` (scope/terms/document generation + signing hash)
- `lib/` — Infrastructure wrappers: `ai.js` (Gemini `generateContent` client; `chat()` → string)
- `scraperService.js` — Puppeteer Google Maps scraper (browser always closed via finally)
- `migrations/` — Schema migrations run on server startup (tracked in `_migrations`)
- `public/` — Static HTML: `index.html` (landing), `get-quote.html` (intake), `book.html` (calendar), `confirm.html` (confirmation), `contract.html` (customer signing page), `admin.html` (admin console)

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
- `_migrations` — Applied migration tracking

**External integrations:**
- Google Gemini API (`GEMINI_API_KEY`, model `gemini-3.5-flash`, `GEMINI_MODEL` override) — lead qualification scoring
- Resend (`RESEND_API_KEY`, optional `EMAIL_FROM`) — lead acknowledgement, quote + booking link, appointment confirmation, contract signing link
- Stripe (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) — Checkout sessions for quote deposits; webhook at `POST /api/payments/webhook` marks quotes `deposit_paid`/`paid`. All payment features no-op cleanly when the secret key is unset
- R2 upload proxy (`R2_UPLOAD_URL`, `R2_API_KEY`) — optional photo uploads from the intake form (up to 5 images per lead); leads save without photos when unset

**Security notes:**
- Admin API and both scraper endpoints require `ADMIN_TOKEN` (bearer). If `ADMIN_TOKEN` is unset they fail closed with 503 — there is no unauthenticated mode.
- The public contract page is gated by the contract's random access token, not its id.
- Signed contracts lock: no edits, and the API refuses to void them.

**Recent changes:**
- 2026-10: Full build-out — admin fail-closed auth + authenticated scraper, Anthropic → Gemini swap, real pricing seeds (migration 002), auto-generated booking slots + fixed booking links (`/book` resolves via static `extensions: ['html']`, production fallback host), real admin console, persisted scraper results, honest email/quote status tracking, Stripe deposit payments (migration 003), and online contracts with e-signature (migration 005)
- 2026-05-06: Built core lead-to-booking engine — intake form, AI qualification, quote generation, calendar booking, email confirmations, admin dashboard with pricing rule editor
