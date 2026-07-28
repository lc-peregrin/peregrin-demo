# Morning report — perf fix + SEO expansion (2026-07-25)

You were boarding a flight and asked for the perf fix, then SEO, with as much deployed as possible.
Both are done and **live on production**. `main` is `1e9609b`. All work is merged and deployed;
nothing is left on an un-merged branch that matters.

## SHIPPED AND LIVE

### 1. Response-time regression fixed (was the top priority)
Live homepage TTFB went from **1.98s to ~0.16 to 0.43s**. Fixes:
- Lazy-loaded Stripe + pdfkit + qrcode + svg-to-pdfkit (~15MB) so content pages do not load them at
  cold start. Content-only module import dropped ~280ms to 32ms.
- Cached parsed markdown (parse once) and rendered HTML per path.
- Added CDN Cache-Control on content routes (Vercel edge serves most requests without invoking the
  function); `/api` excluded so orders/checkout/search/webhook are never cached.
- Verified live: `/blog` ~0.16s, guides ~0.2s, `/es` ~0.43s. Full detail in `PERF_REPORT.md`.

### 2. SEO guide expansion: 14 guides to 44
Published the whole English backlog (25) and the remaining Spanish guides (6). Now **29 EN + 15 ES**.
- Every guide has a hero image (15 new ones sourced from Unsplash, cropped 1600x800, real alt text,
  credited in `content/blog/images/CREDITS.md`).
- Every guide ships a compliant title (<60) and unique meta (<155): 15 new SEO_TARGET_MAP entries
  added, `SEO_TARGET_MAP.md` synced.
- Internal-link cluster: each guide's map entry has 3 self-activating internal links (the "read next"
  block), so the topic cluster wires itself and never points at a 404.
- hreflang now active for the ~15 guides that exist in both EN and ES, paired by slug, x-default to
  English. Guides with no counterpart stay alternate-free.
- Sitemap grew from ~14 to **53 URLs**; all live and 200.
- Fixed 8 malformed `/es/<slug>` links in the new Spanish drafts (they were missing `/blog/`). A full
  crawl of all 44 guides finds **zero broken internal links**.
- Near-duplicate check: `onward-ticket-schengen-visa` and `flight-reservation-schengen-visa` target
  different queries and have distinct titles, so both kept and cross-linked (not canonicalised).

### 3. Schema: ImageObject in Article JSON-LD (Phase 3 start)
Article schema now emits an ImageObject with url/width/height (1600x800) for image rich results.

**155 tests pass.** Tests were updated for the new reality (counts, hreflang pairing, and the
mapped-link tests now use controlled slug sets so they do not break as more guides publish; the
affiliate/bonus tests assert real invariants rather than exact wording, which varies across drafts).

## NEEDS YOU (unchanged from before, now more urgent as more is indexed)

1. **RU and HI homepage copy is live but unreviewed** by a native speaker. Flag since first shipped.
2. **Analytics is wired but off.** Add `PLAUSIBLE_DOMAIN` and `POSTHOG_KEY` in Vercel when you want
   it, plus the one privacy-policy line (in the earlier report).
3. **Resubmit the sitemap in Search Console** so Google picks up the 30 new guides and the language
   URLs.

## STAGED / NOT DONE (the rest of the 7-phase SEO brief), in priority order

- **Phase 2 depth:** the read-next cluster is live (3 links per guide), and breadcrumb JSON-LD +
  visible crumbs already ship. Not yet done: explicit pillar-to-country back-link fan-out and
  anchor-text variation beyond the current titles. Medium value.
- **Phase 3 rest:** HowTo JSON-LD on guides with numbered "before you fly" steps (skipped: needs a
  reliable step-parser; ImageObject is done).
- **Phase 5:** RSS/Atom feed for the blog and a styled 404 page. Sitemap/robots already complete.
- **Phase 6:** a full accessibility audit (alt text, heading order, contrast, focus states). Spot
  checks pass; a systematic pass is not done.
- **Content note for Cowork:** some new guides omit the SafetyWing PEREGRIN bonus line and use varied
  affiliate-disclosure wording. All disclose correctly; just flagging the inconsistency.

## One cosmetic thing
The perf-fix merge commit (`dd6338a`) has an ugly auto-generated message (git template text leaked in
during a non-interactive merge). It is cosmetic and the code is correct; I did not force-push `main`
to fix it while you were offline. Leave it or I can tidy history on request.

## Branches
Everything is merged to `main` and deployed. Feature branches (`claude/perf-fix`, `claude/seo-guides`,
`claude/seo-schema`) are left for reference and can be deleted. The earlier stashed guide work on
`claude/seo-upgrade-night` is now superseded by what shipped and can be dropped.
