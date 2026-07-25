# Morning report — overnight SEO run, 2026-07-25

Branch **`claude/overnight-seo`**, 6 commits, **140 tests passing**. `main`, `.env`, Stripe, Duffel
and Vercel were never touched. Nothing is deployed: everything waits on the branch for you to review
and merge with coffee.

Finished around 02:07, well inside the 06:00 stop. The full change log with timestamps is in
`OVERNIGHT_LOG.md`.

## How to review

```bash
cd site
git checkout claude/overnight-seo
npm test          # 140 pass
node server.js    # then open the URLs below
```

Worth a look in the browser: `/`, `/es`, `/ru`, `/hi`, `/blog`, one guide, and `/faq`.

## What shipped (all 7 items)

**1. On-page targets applied to the 8 live pages.** Title, meta, H1 and JSON-LD now come from
`SEO_TARGET_MAP.md` on the homepage, `/blog`, `/sample-reservation`, `/privacy` and the four live
guides. The map is transcribed into `seo-targets.js`; tests check every entry against the map's own
rules, so a bad edit fails loudly. The three over-length metas use your corrected wording.

**2. Self-activating internal links.** The map prescribes links to 10 guides that do not exist yet.
Rendering them today would have put 11 links to 404s across 5 live pages. Instead every mapped link
is filtered against the pages that actually exist and switches itself on the moment its guide is
published, with no code change. A test simulates publishing the Vietnam guide and confirms the link
appears by itself. This is the rule that lets your overnight writer add guides without wiring links
by hand.

**3. Corrected metas** are the ones in use.

**4. Homepage H1 fixed.** It had five H1s (the hero plus four hidden app screens). Now exactly one;
the others are H2 with identical styling, so nothing looks different.

**5. OG / Twitter / sitemap / robots / headers.** Open Graph and Twitter cards on all 6 page types
(guides reuse their own hero as the image). `X-Powered-By` disabled. Sitemap and robots.txt already
existed and now include the language URLs; `/sample-reservation` was pulled from the sitemap (see
"Needs you" below).

**6. Analytics: Plausible + PostHog.** Both wired, both **inert until you supply credentials** (I
cannot touch `.env`). With no keys the pages make zero external requests. PostHog is configured
cookieless with session recording off, so no consent banner is needed. All six events are wired
through a vendor-neutral `peregrinTrack` shim: `search_submitted`, `offer_selected`,
`checkout_started`, `payment_completed`, `guide_read` (fires at 50% scroll, not on load), and
`guide_to_product_click`.

**7. Multilingual fix — SHIPPED for the homepage.** This is the big one and the one you said to stage
if it could not be done clean. It is done clean. `/es`, `/ru`, `/hi` are now real URLs whose HTML
arrives **already translated server-side**, each with the correct `<html lang>`, a self-referencing
canonical, and a full reciprocal hreflang cluster including x-default. The language switcher now
navigates to the matching URL so the address bar, the lang attribute and the content can never
disagree. I verified all four in a real browser: no console errors, the booking search tool works on
the Spanish page, and switching language navigates correctly.

I confirmed the whole booking flow still works after the H1 and switcher changes: `search_submitted`
fires on a real click and nothing throws.

## Needs you (three decisions, none blocking)

1. **`/sample-reservation`: noindex vs. sitemap.** The earlier sample-document brief made this page
   `noindex`. `SEO_TARGET_MAP.md` gives it a keyword, title, meta and schema, which implies it should
   rank. Those two contradict each other, so I applied the targets but **left it noindex and removed
   it from the sitemap** rather than reverse your explicit earlier instruction unattended. If you want
   it to rank, say so and I will drop the noindex. If not, it is correct as is.

2. **Analytics credentials.** To switch analytics on, add to Vercel's environment:
   `PLAUSIBLE_DOMAIN=peregrin.travel` and `POSTHOG_KEY=<your project key>` (optionally
   `POSTHOG_HOST`). Nothing is collected until then. When you do, add an analytics line to the privacy
   policy, which is currently silent on it.

3. **Localised page titles.** The `/es`, `/ru`, `/hi` `<title>` and meta description reuse your
   already-approved translated hero strings, because `SEO_TARGET_MAP.md` only specifies English
   targets and I would not invent marketing copy in three languages. They are correct and in-language,
   but if you want purpose-written localised titles, that is a Cowork task and I will drop them in.

## Not done, on purpose

- **Per-guide language URLs.** The guides are English-only. Serving English prose under `/es/blog/...`
  is duplicate content, and claiming a Spanish alternate for an English page is worse than none. If
  Cowork produces translated guides, the same machinery extends to them cleanly.

## New files

- `seo-targets.js` — the map in code, plus the self-activating link rule.
- `i18n-pages.js` — server-side language rendering and hreflang.
- `test/seo-targets.test.js`, `test/i18n-pages.test.js`, `test/analytics.test.js` — 34 new tests.

## Standing note (fourth time)

`WRITING_STYLE.md` still does not exist in the repo, though it is referenced across briefs. The
no-em-dash and no-"fake" rules are enforced by tests regardless. `peregrin/research/MARKET_RESEARCH.md`
and `peregrin/MONETIZATION_PLAN.md` are also referenced but not on disk; I cannot read the Claude
Project, so anything grounded in them came from what you pasted.
