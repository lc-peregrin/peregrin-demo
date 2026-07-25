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

## Batch — 2026-07-25, branch claude/cowork-batch-01 (off claude/overnight-seo)

Inputs read from cowork-drafts/: NEW_ANGLE_AND_LOCALISED_COPY.md, 9 Spanish guides in blog-es/,
blog-en/ empty (English backlog not yet added, noted and skipped).

| Time | Change | Tests |
| --- | --- | --- |
| 08:03 | Branch `claude/cowork-batch-01` off `claude/overnight-seo` (not yet merged to main). | 140 baseline |
| 08:20 | Item 1: new-angle hero subhead (hero_angle) added under the lede in all 4 langs; English-only benefit bullet injected server-side into the why area; accurate framing (check-in + immigration, not customs); "fraction of the price" kept. | 140 pass |
| 08:20 | Item 2: /es /ru /hi localised title + meta packs applied; ru/hi H1 updated to pack wording. RU/HI flagged unreviewed. | 140 pass |
| 08:45 | Items 3+4: Spanish blog layer. 9 guides normalised into content/blog-es/, served at /es/blog and /es/blog/:slug. Lang-aware renderer (ctx): Spanish chrome, self-canonical, lang=es. Dead body links to unpublished /es guides neutralised (self-activating). FAQ (Preguntas frecuentes) and Spanish affiliate disclosure recognised. hreflang pairs by slug (none active yet, no EN counterparts). Sitemap includes /es/blog + 9 guide URLs. English output byte-identical. | 149 pass |
| 09:05 | Sourced 6 Unsplash heroes (colombia, costa-rica, mexico, peru, visa-paperwork shared by 3, checkin-counter), cropped 1600x800; schengen guide reuses existing schengen-hero. Alt text set accurately per image. CREDITS updated. | 149 pass |
| 09:15 | Item 5: confirmed all six analytics events fire (homepage 4 + guide 2, English and Spanish), still inert without credentials. | 149 pass |
| 09:15 | Item 6: /sample-reservation noindex removed and added to sitemap (Liam's explicit call); targets "sample flight reservation for visa". Test updated. | 149 pass |
| 09:25 | Full-site link crawl (20 unique internal links, 0 broken), full suite 149 pass, English confirmed unchanged, main untouched at 116bd64. BATCH_REPORT_2026-07-25.md written. | 149 pass |
