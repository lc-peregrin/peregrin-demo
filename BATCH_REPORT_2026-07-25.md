# Batch report — new angle, localisation, Spanish guides, analytics

Branch **`claude/cowork-batch-01`** (off `claude/overnight-seo`, which is not yet merged). Five
commits, **149 tests passing**. `main`, `.env`, Stripe, Duffel and Vercel untouched. Nothing is
deployed. Full change log with timestamps in `OVERNIGHT_LOG.md`.

## How to review

```bash
cd site
git checkout claude/cowork-batch-01
npm test          # 149 pass
node server.js    # then open the URLs below
```

Worth opening: `/`, `/es`, `/ru`, `/hi`, `/es/blog`, a Spanish guide such as
`/es/blog/proof-of-onward-travel-colombia`, and an English page to confirm it is unchanged.

## What shipped (all 7 items)

**1. New benefit angle (English).** The new-angle hero subhead is added under the existing lede in
all four languages (English from the brief, es/ru/hi from the packs). Framing is accurate: the copy
says check-in and immigration, never customs. The "fraction of the price of a real ticket" line is
kept. The benefit bullet is injected on the English homepage only, because Cowork supplied no
localised bullet and an English bullet on a Spanish page is worse than none.

**2. Localised homepage copy.** /es /ru /hi now use the pack title, meta and H1. es/ru/hi hero
subheads carry the new angle.

**3. Spanish guides published.** Nine guides live at `/es/blog` and `/es/blog/<slug>`, front-matter
normalised to match the English guides, each with a sourced hero (see credits). The Spanish bodies'
own "Guías relacionadas" cross-links do the cross-linking; dead links to guides not yet published
are unwrapped to plain text and self-activate later.

**4. Multilingual machinery.** Spanish guides are lang=es, self-canonical, and hreflang-paired to
their English counterpart by slug. No Spanish slug matches a live English slug yet, so no guide emits
hreflang today; it self-activates when a counterpart is published, exactly like the internal links.

**5. Analytics.** All six events confirmed firing after the refactor, on the homepage and on both
English and Spanish guides. Still inert until credentials are supplied (below).

**6. /sample-reservation** is now indexable and in the sitemap, targeting "sample flight reservation
for visa", per your instruction. The SAMPLE watermark and "example only" copy remain.

**7. This report**, plus the log.

## NEEDS YOU

1. **RU and HI homepage copy is an unreviewed draft.** It is wired in so the pages are complete, but
   Cowork flagged it for native-speaker review, and I cannot verify it. Get both confirmed before
   treating them as final. Spanish is good to ship.

2. **Analytics credentials (unchanged from last time).** In Vercel's environment:
   `PLAUSIBLE_DOMAIN=peregrin.travel` and `POSTHOG_KEY=<your project key>` (optional `POSTHOG_HOST`,
   defaults to EU). Nothing is collected until then. One privacy-policy line to add when you do:
   "We use privacy-friendly, cookieless analytics (Plausible and PostHog) to understand which pages
   are useful. No personal profiles are built and no advertising cookies are set."

3. **Near-duplicate check (item 3): no cannibalisation, no action needed.** The Spanish
   `onward-ticket-schengen-visa` and the English `flight-reservation-schengen-visa` are different
   languages and different slugs, so they compete in different search results. Within Spanish there
   is only one Schengen guide. Nothing to canonicalise.

## Things I decided, flag for your eye

- **The Spanish drafts cross-link to guides that do not exist in Spanish** (thailand, vietnam,
  philippines, bali, a Spanish `flight-reservation-schengen-visa` that was not supplied, plus
  `digital-nomad` and `onward-ticket-meaning`). Those links render as plain text now and become real
  links when the guides are published. Nothing points at a 404.

- **Spanish blog chrome** (nav, sidebar, index copy) uses safe UI labels and, for anything making a
  product claim, reuses already-approved homepage Spanish. The "Before you fly" sidebar checklist has
  no approved Spanish, so it is omitted on Spanish guides rather than machine-translated.

- **Three visa-paperwork guides share one hero image**, and image alt text was set to describe the
  actual images rather than the drafts' imagined scenes. Details in
  `content/blog/images/CREDITS.md`.

- **The es/ru/hi pack copy has some missing Spanish accents** in the source (inmigracion, usaras,
  fraccion). Applied verbatim rather than "correcting" copy; a quick Cowork orthography pass would
  polish them.

- **Help and Privacy links on Spanish pages point to the English /faq and /privacy**, since there are
  no Spanish versions of those. A Spanish reader lands there with the language switcher available.

## Review, merge and deploy steps

This branch sits on top of `claude/overnight-seo`, which is also unmerged. To ship both:

1. Review this branch: `git checkout claude/cowork-batch-01 && npm test && node server.js`, click
   around the URLs above.
2. Get RU and HI homepage copy confirmed by a native speaker (or hold just those by reverting the two
   pack entries in `i18n-pages.js`; Spanish and English are fine to ship now).
3. Merge the base branch first, then this one, into main:
   ```bash
   git checkout main
   git merge --no-ff claude/overnight-seo
   git merge --no-ff claude/cowork-batch-01
   npm test
   git push origin main
   ```
   Vercel auto-deploys `main`. (Or open two PRs, overnight-seo first, if you prefer review in GitHub.)
4. After deploy: add the analytics env vars in Vercel when you want measurement on, submit the updated
   sitemap in Search Console, and add the privacy-policy analytics line.

## New files this batch

- `content/blog-es/*.md` — 9 Spanish guides.
- `content/blog/images/{colombia,costa-rica,mexico,peru,visa-paperwork,checkin-counter}-hero.jpg`.
- `test/blog-es.test.js` — 10 tests for the Spanish section.
- Edits: `blog.js` (language-aware rendering), `i18n-pages.js` (packs + bullet), `public/index.html`
  (angle), `server.js` (routes, sitemap, sample-reservation).
