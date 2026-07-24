# Peregrin — booking demo (`site/`)

The live product: a working demo that sells genuine, verifiable flight and
accommodation reservations (real airline PNRs held via Duffel's API) used as
proof of onward/return travel for visa, immigration, and check-in requirements.
Deployed on Vercel, auto-deploys on push to `main`.

> This is orientation only. For engineering gotchas, API quirks, and the "how a
> booking actually works" walkthrough, read [`CLAUDE.md`](./CLAUDE.md) — it is
> the source of truth and this file deliberately does not duplicate it.

## Project structure

```
site/
├── server.js            — the entire backend: Express, all /api routes,
│                          Duffel + Stripe + Resend integrations, PDF generation
├── public/
│   ├── index.html       — the entire frontend: HTML + CSS + JS in one file,
│   │                      no build step, no framework (see "Booking flow" below)
│   ├── favicon*, og-image.png, apple-touch-icon.png — brand assets
│   ├── robots.txt, sitemap.xml
├── test/
│   └── booking-flow.test.js — safety tests for the inline frontend script
├── package.json
└── CLAUDE.md            — engineering context + gotchas (read this)
```

There is no bundler and no transpile step. `public/index.html` is served as-is;
its JavaScript lives inline in a single `<script>` block near the bottom of the
file.

## Run it locally

```bash
npm install
node server.js   # http://localhost:3000
```

Needs a `.env` (gitignored) with `DUFFEL_API_KEY`, `RESEND_API_KEY`,
`STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET`. All four integrations are gated
so missing keys return a clean `501` instead of crashing — the site runs locally
with only some (or none) configured, you just can't exercise those flows.

## Run the tests

```bash
npm test
```

Plain `node --test`, no dependencies. It extracts the inline `<script>` from
`public/index.html`, syntax-checks it, and exercises the booking-confirmation
rendering across all four languages inside a minimal stub DOM. Its job is to
catch a specific, real failure mode: because there's no linter or type-checker in
the pipeline, a reference to something that isn't actually in scope (an assumed
global) ships silently and only throws when that code path runs in a browser.
See the header comment in [`test/booking-flow.test.js`](./test/booking-flow.test.js)
for exactly what is asserted.

## Where the booking flow lives

The customer journey is split across the two files:

- **Frontend** — `public/index.html`, inline `<script>`. Search → select offer →
  traveller details → `renderOrder()` draws the confirmation screen (booking
  reference, countdown, verify / download / email / pay controls). A parallel
  "stays" (accommodation) flow sits alongside it.
- **Backend** — `server.js`. The `/api/*` routes: `search`, `hold`, `order/:id`
  (verify), `order/:id/pdf`, `order/:id/email`, `order/:id/confirm` (test-balance
  demo payment), `order/:id/checkout` (real Stripe path), `stripe/webhook`, and
  the `stays/*` equivalents.

`CLAUDE.md`'s "How a booking actually works" section walks the sequence end to
end, including which payment path is the real production shape.
