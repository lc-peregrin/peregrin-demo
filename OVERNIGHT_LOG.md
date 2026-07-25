# Overnight log — 2026-07-25

Branch `claude/overnight-seo`. Never touches `main`, `.env`, Stripe, Duffel or Vercel.
Test suite is run before every commit; no commit lands with a failing suite.

| Time | Change | Tests |
| --- | --- | --- |
| 01:46 | Branch `claude/overnight-seo` created off `main`. | 106 pass (baseline) |
| 01:50 | Added `seo-targets.js`: the SEO_TARGET_MAP transcribed into code, plus `liveLinks()`, the self-activating internal-link rule. | pending |
| 02:20 | Applied on-page targets (title/meta/H1/schema) to the 8 live pages; homepage schema now Organization + WebSite. Items 1 and 3. | 120 pass |
| 02:20 | Self-activating internal links via `liveLinks()`, rendered on guides, /blog, homepage and /sample-reservation. No link to a 404 can render. Item 2. | 120 pass |
| 02:20 | Homepage reduced from 5 H1s to exactly 1; other SPA views use `.view-h1` (H2) with identical styling. Item 4. | 120 pass |
| 02:20 | FAQPage schema extracted from each guide's existing FAQ section; emitted only when questions really exist on the page. | 120 pass |
| 02:20 | `X-Powered-By` disabled; `/sample-reservation` added to sitemap. Part of item 5. | 120 pass |
| 02:05 | Open Graph + Twitter card tags added to /privacy, /verify, /sample-reservation (the three server-rendered pages that had none). All 6 live page types now carry OG, Twitter and a canonical. Item 5. | 120 pass |
| 02:05 | /sample-reservation removed from sitemap: it is `noindex`, and noindex plus a sitemap entry are contradictory signals. Needs a decision, see MORNING_REPORT. | 120 pass |
| 02:35 | Analytics: Plausible (site-wide, cookieless) + PostHog, each gated on its own env var. Zero external requests until credentials exist. Vendor-neutral `peregrinTrack` shim always present. All six briefed events wired. Item 6. | 127 pass |
| 02:35 | Retired the earlier Vercel Web Analytics tag and `ENABLE_ANALYTICS`, superseded by Plausible. | 127 pass |
| 03:05 | Multilingual: real crawlable URLs /es, /ru, /hi serving server-side translated HTML, correct `<html lang>`, self-canonical, full hreflang cluster with x-default, added to sitemap. Language switcher now navigates so URL and content agree. Item 7 SHIPPED (homepage), guides deliberately excluded. | 139 pass |
| 03:05 | Language page titles and descriptions reuse the already-approved translated hero strings rather than leaving English metadata on a Spanish page. | 139 pass |
| 03:20 | Routed /faq through the shared renderer so it gets the analytics shim; gave it its own canonical (it was inheriting the homepage's, which would have deindexed it) and no language alternates. | 140 pass |
| 03:25 | Full-suite run (140 pass), browser verification of all four language pages and the booking flow, MORNING_REPORT.md written. Overnight run complete at 02:07, inside the 06:00 stop. | 140 pass |
