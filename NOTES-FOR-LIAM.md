# Notes for Liam

Decisions and flags that need your call, newest first. The pricing + design pass
lives on branch `claude/pricing-and-design-v1` (commits: TASK 1, then TASK 3, then
TASK 2 — so you can merge just TASK 1, or 1+3, or all three).

---

# Pricing & design pass (2026-07-24)

## A. The four Claude Design files are missing — TASK 2 is partial (please read)

**The single most important flag.** TASK 2 names four files (`Peregrin Homepage.dc.html`,
`Peregrin Booking Flow.dc.html`, `Peregrin Verify Page.dc.html`, `Peregrin SEO Template.dc.html`)
and `design-exports/RATIONALE.md` as its source of truth. **None of them exist** —
anywhere on the machine. `design-exports/` still holds only the logo asset set,
and its own README still says "Empty right now — no Claude Design session has been
run yet." STATE.md says Claude Design "produced 4 layout specs," but they were
never exported to disk. It looks like the Claude Design session was planned/briefed
but its output never landed in the repo.

What I did about it: built the parts of TASK 2 that are **decided independently of
those files** (the typeface pairing you already approved; a homepage trust layout
following the written brief + `docs/BRAND.md`; a real, working Verify page). These
are **on-brand interpretations, not integrations of the actual mockups** — when the
real exports land, they should be reconciled against what I built (the structure
should be close; exact spacing/copy may differ).

What I did **not** build, on purpose:
- **The SEO landing-page template + the two example pages (Thailand onward ticket,
  Schengen tourist visa).** The task says to use the *real* country/FAQ content
  from the design file — which doesn't exist — and I won't invent authoritative-
  sounding visa/immigration requirement text and ship it as real, indexable pages.
  That's both an accuracy risk and exactly the "known-fake evidence" sensitivity
  your own compliance review flags (BUSINESS_PLAN §5). **Blocked on the real content
  + the `{{ token }}` dataset.** Re-run once the design export (or the content) exists.

**Your call:** re-run the Claude Design brief so the exports actually land, then I can
integrate them properly and build the SEO templates against real content.

## B. TASK 1 — the hold fee is charged in USD, the airline fare is in AUD

The task assumed the site displays USD. It doesn't: your Duffel account is
**AUD-denominated**, so all fare figures come back as AUD. I priced the hold fee
in **USD** anyway ($14.99 / $19.99), because §3 sets those numbers by benchmarking
against USD-priced competitors (onwardticket.com at $16). So a customer sees the
hold priced in USD and, if they later choose to fly, the airline fare in AUD.

This is defensible (the hold fee is your product, priced to your market; the fare is
a pass-through) and it's how I shipped it — but it's a **customer-visible currency
mix** and therefore your decision. It's a one-line change: `HOLD_FEE_CURRENCY` in
`server.js` (or the env var) controls it. **Recommendation:** keep USD for the hold
fee — it matches the competitors you're positioning against. Flagging so it's your
call, not mine.

## C. TASK 1 — I gate the *document*, not the hold creation (deliberate)

I made the hold fee unlock the PDF/email **after** the Duffel hold already exists,
rather than taking payment *before* creating the hold. Why: Duffel offers are
single-use and short-lived ("one order per offer request"), so sending the customer
off to Stripe *before* creating the hold risks the offer expiring mid-checkout and
leaving a paid customer with nothing to deliver. Gating the document also reuses the
existing order-id-keyed flow cleanly.

**The trade-off you should know:** because the hold is created first, Duffel's ~$3
order fee is incurred **even if the customer abandons before paying** the $14.99.
At low volume that's noise; at scale with high abandonment it eats margin. If
abandonment turns out high once live, the fix is a lighter pre-hold step. Noted so
it's a conscious choice, not a surprise on the Duffel invoice.

## D. TASK 1 — entitlement isn't durably stored yet (before real launch)

"Which orders have paid the hold fee" is verified statelessly against the Stripe
session on return from checkout (works on Vercel's serverless), plus an in-memory
cache. The in-memory part is **not durable** — if the serverless instance recycles,
a customer coming back days later with only their PDF link may not re-download until
they re-verify. Before real launch this should live in a datastore (or be written to
Stripe/Duffel order metadata). Fine for test-mode review now; flagging for go-live.

## E. Typeface is loaded from Google Fonts

Source Serif 4 + Public Sans are pulled from Google Fonts (the standard OFL delivery).
That adds one external request. For a site whose whole pitch is trust/independence,
you may prefer to **self-host** the two fonts (no third-party request, works offline)
— easy to switch later. Not urgent; noted.

## F. Support page (FAQ + contact) — flagged, not built

onwardticket.com has a support page advertising "24/7 human support, 30-minute
responses." A lightweight FAQ + contact page is worth adding and is easy — but the
**responsiveness claim must not be copied unless you actually staff it**; advertising
support you can't deliver would hurt trust more than not having the page, and cuts
against the "no over-promising" voice in `docs/BRAND.md`. Left for you: decide the
support model and the copy, then it's a quick build.

---

# Overnight safety pass (2026-07-24)

One thing hit the "don't change customer-visible behaviour without sign-off" bar
during the earlier safety pass; kept here for the record.

---

## 1. The language switcher is off by one — ✅ FIXED (you approved it, 2026-07-24)

> **Update:** you gave the go-ahead, so this is now fixed on the branch. `applyLang`
> now uses the language it's handed (`translations[lang]`), and a new test
> (`switching language via the dropdown takes effect on the first change`) fails
> against the old code and passes against the fix. The write-up below is kept for
> the record.

**What's wrong, in plain terms:** when a visitor picks a different language from
the dropdown, the page changes to the language they picked *one step late*. So:

- Page loads in English (correct).
- Visitor picks **Español** → the page stays **English**.
- Visitor then picks **Русский** → the page switches to **Español** (the one they
  picked *last* time), not Russian.

It's always showing the previously-selected language, not the current one. On a
fresh load the saved language is applied correctly, so most visitors who set a
language once and come back are fine — the glitch shows up when someone actively
switches languages in a single visit, which is exactly what a first-time visitor
testing the site does.

**Why it happens (one sentence):** the function that swaps the text
(`applyLang`) is being told which language to use, but instead of using what it
was told, it re-reads the *previously saved* language from browser storage —
which hasn't been updated to the new choice yet at that moment.

**Where:** `public/index.html`, inside `applyLang` (around line 451):

```js
function applyLang(lang) {
  const dict = translations[localStorage.getItem("peregrin_lang") || "en"] || translations.en;
  ...
```

It reads storage instead of using the `lang` it was handed.

**The fix is one line** — use the language passed in:

```js
function applyLang(lang) {
  const dict = translations[lang] || translations.en;
  ...
```

**Why I didn't just do it:** this changes what a visitor sees on screen when they
click the language dropdown, and the rule for this pass was "no customer-visible
behaviour changes without you signing off." It's a genuine bug and the fix is
tiny and safe, but it's your call, so it's parked here. This is the same family
as tonight's `lang` bug — the over-eager find/replace that fixed the crash also
reached into this function, where `lang` was a legitimate value it should have
kept using.

**Recommendation:** approve the one-line change. It's low-risk and makes the
language switcher actually work on the first click. Say the word and I'll apply
it (and add a test that would have caught it).

---

## 2. For context — what the pass *did* change (all safe, on the branch)

- Added `test/booking-flow.test.js` + an `npm test` script (plain `node --test`,
  no new dependencies, no build step). It re-checks the booking confirmation
  screen renders in all four languages without crashing — the automated net that
  would have caught tonight's production bug before it shipped.
- Added `site/README.md` (orientation only).
- Documented `npm test` in `site/CLAUDE.md`.

None of the above touches the product's behaviour, pricing, payments, or copy.

## 3. Smaller thing worth knowing (not a bug, no action needed)

On the confirmation screen, the "Ticketed" heading and its sub-line (shown after
a reservation is paid/confirmed) are hard-coded in English inside `renderOrder`,
so they stay English even when the rest of the page is in another language. It's
a translation gap, not a crash, and it predates this pass — flagging only so it's
on your radar if you ever do a full localisation sweep. Fixing it would be a
copy/behaviour change, so it's out of scope here.
