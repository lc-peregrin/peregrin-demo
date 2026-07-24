# Go-live checklist — Peregrin (`/site`)

What still has to happen before the site takes **real** money and issues **real**
tickets. As of the pricing/FAQ pass (2026-07-24) the site is **deployed and
ready but running entirely in Duffel + Stripe TEST mode** — it charges nothing
real and books nothing real until the production keys below are added.

Ordered roughly by what blocks real revenue first.

---

## 1. Payment + supplier keys (the actual "go live" switch)

- [ ] **Stripe live keys.** Swap the test `STRIPE_SECRET_KEY` and
      `STRIPE_WEBHOOK_SECRET` for live-mode values (Vercel env vars). Requires
      Stripe business verification/activation to be complete first.
- [ ] **Register the Stripe live webhook** endpoint (`/api/stripe/webhook`) in
      the live dashboard and set its signing secret. The webhook is what unlocks
      the document (hold fee) and tickets the order (fare) — it must be live-mode
      or paid customers get nothing back.
- [ ] **Duffel production keys.** Swap the test `DUFFEL_API_KEY` for a live key
      once Duffel go-live is approved. Until then every hold/verify is test data.
- [ ] **Confirm the live Duffel account currency** and re-check the displayed
      pricing. Test mode returns **AUD** fares; the hold fee is deliberately
      charged in **USD** ($14.99 / $19.99). That USD-fee / AUD-fare split is an
      intended, reviewed decision (kept as-is) — just re-verify it still reads
      correctly against the live account before launch. Controlled by
      `HOLD_FEE_CURRENCY` / `HOLD_FEE_STANDARD` / `HOLD_FEE_MULTI` in `server.js`.
- [ ] **End-to-end live smoke test** with a real card (small, refunded): search →
      hold → pay $14.99 → document unlocks and emails → and separately the
      confirm-to-fly fare path still tickets.

## 2. Durable hold-fee entitlement store (before real charges)

- [ ] Replace the in-process `paidHoldOrders` Set in `server.js` with a durable
      store. On Vercel each request can hit a fresh serverless instance, so the
      in-memory record of "this order paid its hold fee" is **not durable**. The
      stateless fallback (re-checking the Stripe Checkout Session on return)
      covers the immediate post-payment redirect, but a customer returning days
      later with only their PDF link could be blocked from re-downloading.
      Options: a small KV/DB, or write the entitlement into the Stripe/Duffel
      order metadata and read it back. **Deferred by Liam; required before real
      charges.**

## 3. Self-host the two webfonts (deferred, not blocking)

- [ ] Source Serif 4 + Public Sans currently load from Google Fonts (an external
      request per visit). For a trust-first site, self-hosting the two OFL fonts
      removes the third-party dependency and works offline. **Deferred by Liam.**
      Note: as of go-live prep the fonts live on the (not-yet-merged) design
      branch, not on `main` — fold this in when the Claude Design work lands.

## 4. Operational / policy before scaling

- [ ] **Support inbox.** `hello@peregrin.travel` is published on the FAQ/footer
      with an honest "we'll get back to you quickly" (no SLA). Make sure that
      inbox is actually monitored before driving traffic.
- [ ] **Refund mechanics.** The FAQ commits to a full refund if a valid,
      verifiable reservation can't be delivered. Confirm the operational path to
      actually issue that refund in live Stripe.
- [ ] **Terms / refund page.** The FAQ references a refund policy; a formal
      Terms + Refund page should exist and match the FAQ wording before scaling
      (delivery-based refund posture, per `BUSINESS_PLAN.md` §5/§9).
- [ ] **Duffel per-order cost on abandonment.** The Duffel hold is created at
      `/api/hold`, before the fee is paid at `/api/order/:id/hold-checkout`, so
      Duffel's ~$3 order fee is incurred even on abandoned holds. Intended
      trade-off (kept as-is); worth monitoring the abandoned-hold rate once live
      and revisiting if it's material.
- [ ] **Accommodation (Duffel Stays).** Flow is built but gated on separate
      Duffel Stays approval; its FAQ/copy is intentionally kept out of the live
      site until then.
- [ ] **Legal review** before scaling into new jurisdictions (standing
      recommendation from `BUSINESS_PLAN.md` §5).

## 5. Nice-to-have hardening (not blocking launch)

- [ ] Webhook failure alerting/retry (currently logs only — see the comment in
      the `checkout.session.completed` handler).
- [ ] Rate-limit `/api/verify` and `/api/places` (public, un-authenticated).
