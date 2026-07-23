# Peregrin — project context for Claude

Peregrin sells genuine, verifiable flight/accommodation reservations (real airline PNRs held via
Duffel's API) that customers use as proof of onward/return travel for visa and immigration
purposes. This repo is the working demo/prototype: a real integration against Duffel's test-mode
API, deployed live.

## Stack

- Node.js + Express (`server.js`), single-file backend, ESM (`"type": "module"` in package.json)
- Single-page frontend: `public/index.html` (HTML/CSS/JS all in one file, no build step, no framework)
- `pdfkit` for generating the branded reservation PDF
- `stripe` for customer payment (Checkout Sessions)
- Deployed on Vercel, auto-deploys on push to `main`
- Repo: `github.com/lc-peregrin/peregrin-demo`

## Local dev

```
npm install
node server.js   # http://localhost:3000
```

Needs a `.env` (gitignored) with `DUFFEL_API_KEY`, `RESEND_API_KEY`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`. All four integrations are gated so missing keys return a clean 501
instead of crashing — safe to run locally with only some configured.

## How a booking actually works

1. Search (`/api/search`) → Duffel offer search, filters to holdable fares only.
2. Hold (`/api/hold`) → creates a real Duffel order with `type: "hold"`, no payment taken.
   **Duffel only allows one order per offer_request/offer** — don't retry the same offer twice,
   the second attempt 422s with "Can't book multiple offers from the same offer request." The
   hold button is guarded against double-submit for this reason; keep that guard if you touch it.
3. PDF (`/api/order/:id/pdf`) → branded itinerary document.
4. Email (`/api/order/:id/email`) → sends the PDF via Resend, from `reservations@send.peregrin.travel`
   (the verified sending subdomain — NOT the root `peregrin.travel`, which is deliberately left
   unverified in Resend to avoid touching its existing Google Workspace DKIM/DMARC).
5. Payment — two paths exist:
   - `/api/order/:id/confirm` — demo-only "simulate payment," pays via Duffel's fake test-mode
     account balance. No real money involved ever.
   - `/api/order/:id/checkout` — real path: creates a Stripe Checkout Session, customer pays
     Peregrin, and the `/api/stripe/webhook` handler pays the airline via Duffel balance once
     `checkout.session.completed` fires. This is the actual production shape (customer → Peregrin
     → airline).
6. Verify (`GET /api/order/:id`) — re-checks live status directly against Duffel. This is the core
   trust mechanic (real PNR, independently checkable) vs. a forged document.

## Known gotchas (already solved, don't reintroduce)

- **pdfkit + Unicode**: standard fonts use WinAnsiEncoding, can't render `→` or `✓` in `doc.text()`.
  Arrows/checkmarks/the wing-mark logo are drawn as vector paths instead. Don't put raw Unicode
  symbols in PDF text calls.
- **pdfkit state leaks**: any `.fillOpacity()`/similar call outside a `save()`/`restore()` block
  persists for every subsequent draw call including text. Caused a real "all text after this point
  is invisible" bug once. Wrap transient style changes in `save()`/`restore()`.
- **Stripe webhook route must be registered before `express.json()`** — `stripe.webhooks.constructEvent()`
  needs the raw body; the webhook route has its own `express.raw()` parser and must claim the
  request before the global JSON parser does.
- **Duffel timestamps** are ISO8601 with local UTC offset (e.g. `2026-08-15T20:15:00+07:00`) —
  for *display*, parse the date/time digits directly via regex rather than `Date` getters (which
  reinterpret in server-local time). For duration/gap math, `Date` arithmetic is fine.

## Git

Commit and push normally — this is a real local clone with a real `origin` remote. Nothing special
required. Vercel auto-deploys `main`.

## What's not built yet

- B2B/partner API layer (`/reservations` endpoints + webhooks for white-label resellers)
- Duffel Stays access is pending (separate approval from Duffel Flights)
- Duffel go-live (production API keys) — currently test-mode only

See `Peregrin_Business_Model_and_Operations.md` and `Peregrin_Marketing_Program.md` (in the
project's Google Drive folder, not this repo) for the fuller business context.
