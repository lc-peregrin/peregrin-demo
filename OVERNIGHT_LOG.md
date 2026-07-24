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
