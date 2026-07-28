# Performance fix report — homepage TTFB regression

Branch **`claude/perf-fix`** (off `main`, the live state), 1 commit, **154 tests passing** (149 +
5 new). `main`, `.env`, Stripe, Duffel and Vercel untouched. Not deployed.

## Diagnosis (measure first)

Local warm requests were already fast, which located the problem: the ~2s was Vercel
**cold-start plus per-invocation work**, not warm render time or page weight (237 kB is fine).

Two regressions, both introduced by the multilingual + content growth:

1. **~15 MB of modules loaded on every cold start.** `server.js` imported Stripe (133 ms),
   pdfkit (100 ms), qrcode (18 ms) and svg-to-pdfkit at the top level, so even a homepage cold
   start paid to parse all of them, though only the payment and PDF routes use them.
2. **Markdown re-parsed on every request.** `listArticles()` re-read and re-parsed every guide's
   front-matter on each call (and it is called more than once per request), and each guide body
   was re-rendered through `marked` per request. This got worse as the guide count grew.

Measured per-operation cost (local):

| Operation | Before | After |
| --- | --- | --- |
| Content-module cold import (homepage cold-start path) | ~280 ms (incl. Stripe+pdfkit) | **32 ms** (heavy deps not loaded) |
| `listArticles("en")` (called 2x+ per blog request) | 0.65 ms | **0.036 ms** (cached, same array reused) |
| `renderIndexForLang("es")` | 2.57 ms | served from page cache on warm hits |

## Fixes

1. **Lazy-load the heavy deps.** `getStripe()` and `getPdfDeps()` import and instantiate on first
   use, cached for the process. Every `stripe.*` and `PDFDocument` call site keeps its original
   text (each function resolves the dep at its top), so behaviour is identical. A content request
   now loads none of Stripe/pdfkit/qrcode/svg-to-pdfkit.
2. **Parsed-article cache** in `blog.js`, keyed on a cheap file-mtime signature: parse once, reuse
   the same array. Self-invalidates on edit in local dev; never invalidates in production.
3. **Rendered-HTML page cache** for `/blog`, `/blog/:slug`, `/es/blog`, `/es/blog/:slug` and
   `/faq`, so a warm request is a map lookup, not a markdown parse plus render.
4. **CDN Cache-Control** (`public, max-age=0, s-maxage=600, stale-while-revalidate=86400`) on GET
   content routes, so Vercel's edge serves cached responses without invoking the function.
   Excluded on `/api` so order lookups, checkout, search and the Stripe webhook are never cached.

## Before / after (the three requested pages)

Local TTFB is not the live figure (local has no cold start and no CDN), but it confirms the warm
path is now a map lookup and the cold path no longer loads the heavy modules.

| Page | Local warm, before | Local warm, after (cached) |
| --- | --- | --- |
| `/` (homepage) | ~18 ms | ~1.4 ms |
| `/blog/proof-of-onward-travel-thailand` (guide) | ~5 ms | ~0.8 ms |
| `/es/blog/proof-of-onward-travel-mexico` (/es guide) | ~2 ms | ~0.7 ms |

**Expected on Vercel:** the two levers that move the live 1.98 s are the ~250 ms+ of module load
removed from cold starts (larger in wall-clock on Vercel's cold filesystem) and, more importantly,
the edge cache now serving the majority of requests without a function invocation at all, which
takes their TTFB to edge speed. I cannot measure the live number from here without deploying, which
the guardrails forbid; the changes are verified structurally and by test.

## Still slow / caveats

- The **first** request after a deploy (true cold start, cache empty) still pays one module load
  and one parse. It is much smaller now but not zero; the CDN then serves everyone else.
- The homepage is rendered from the 240 kB `public/index.html` via a vm-eval of the translations
  object per language. It is cached per language, so this is a one-time cost per language per
  process, not per request. Build-time static generation (option 2a in the brief) would remove even
  that, but it is a larger change; the in-memory cache was the right scope for one session.

## Review, merge, deploy

```bash
git checkout claude/perf-fix
npm test            # 154 pass
node server.js      # check /, /blog, /es, a guide, and headers:
                    # curl -sD- -o/dev/null localhost:3000/blog | grep -i cache-control
```
Merge to `main` and let Vercel deploy, then re-run Seobility / a TTFB check on the live homepage,
a guide, and an /es page to confirm warm TTFB is under ~0.4 s.

```bash
git checkout main && git merge --no-ff claude/perf-fix && npm test && git push origin main
```

Note: the 31-guide SEO backlog from the same night is stashed on `claude/seo-upgrade-night` and is
independent of this fix (this touches only server.js/blog.js code, not guide content).
