# CrewMind

**What this app does:** AI-powered lead qualification and booking engine for home services businesses. Homeowners submit job requests via intake form; AI scores leads, auto-generates quotes from configurable pricing rules, and emails booking links for estimate appointments.

**Stack:** Node.js + Express 4 + PostgreSQL (Neon) + Polsia AI proxy + Polsia email proxy + Cloudflare R2 (photos)

**Directory map:**
- `server.js` — Entry point: middleware, route mounts, startup migrations
- `routes/` — HTTP handlers: `leads.js`, `appointments.js`, `admin.js`
- `db/` — All SQL queries: `index.js` (Pool), `leads.js`, `quotes.js`, `appointments.js`
- `services/` — Business logic: `lead-qualify.js` (AI scoring), `quote-engine.js` (pricing), `email.js` (email proxy)
- `lib/` — Infrastructure wrappers: `polsia-ai.js` (Anthropic SDK pointed at Polsia proxy)
- `migrations/` — Schema migrations run on server startup
- `public/` — Static HTML: `index.html` (landing), `get-quote.html` (intake), `book.html` (calendar), `confirm.html` (confirmation), `admin.html` (dashboard)

**Database:**
- `users` — Polsia platform users (subscription management)
- `pricing_rules` — Configurable base price + per-sqft rate per job type (16 types seeded)
- `leads` — Inbound job requests with AI score, qualification status, photo URLs
- `quotes` — Auto-generated estimates linked to leads, with line items
- `appointments` — Booked estimate slots with confirmation codes
- `available_slots` — Calendar availability (30 business days pre-seeded)
- `_migrations` — Applied migration tracking

**External integrations:**
- Polsia AI proxy (`POLSIA_API_URL`, `POLSIA_API_KEY`) — Lead qualification via Claude
- Polsia email proxy — Lead acknowledgement, quote delivery, appointment confirmation
- Polsia R2 proxy — Photo uploads from lead intake form (up to 5 images per lead)

**Recent changes:**
- 2026-05-06: Built core lead-to-booking engine — intake form, AI qualification, quote generation, calendar booking, email confirmations, admin dashboard with pricing rule editor
