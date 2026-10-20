# CrewMind

AI-powered lead-to-booking engine for home services businesses: intake form → AI lead qualification → instant quote → online contract signing → deposit payment → estimate appointment booking, plus an admin console and a prospect scraper.

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
| `STRIPE_WEBHOOK_SECRET` | for payments | Signing secret for the webhook endpoint. Register `https://crewmind1-api.onrender.com/api/payments/webhook` in Stripe for the `checkout.session.completed` event. |
| `R2_UPLOAD_URL`, `R2_API_KEY` | no | Photo upload target for intake-form photos. Leads save without photos when unset. |

Settings that change at runtime — deposit percent (default 20%) and business name/address/phone — live in the `app_settings` table and are edited in the admin console, not via env vars.

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

Admin (all require `Authorization: Bearer <ADMIN_TOKEN>`; console at `/admin.html`):
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
