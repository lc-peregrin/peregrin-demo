import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { renderReservationPdf } from "./pdf.js";
import { collectAirlineLogos } from "./airline-logos.js";
import { listArticles, getArticle, renderBlogIndex, renderArticle, renderVisaHub, countryRouteMap, VISA_HUB_ROUTE, buildBlogCtx, guideSlugs, BLOG_IMAGE_URL_BASE, setBlogHeadExtra } from "./blog.js";
import { seoTargetFor, liveLinks, linkLabel } from "./seo-targets.js";
import { renderIndexForLang, hreflangTags, LANG_PATHS, faqPageSchema } from "./i18n-pages.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// No reason to advertise the stack to every visitor and scanner.
app.disable("x-powered-by");

// CDN cache for content responses. Vercel's edge caches on s-maxage and can then
// serve most requests (crawlers, repeat visitors) without invoking the function
// at all, which is what brings TTFB down to edge speed. Deliberately scoped to
// GET requests outside /api: order lookups, checkout, search and the webhook are
// per-request or mutable and must never be cached. Static assets set their own
// longer cache below and override this.
const CONTENT_CACHE_CONTROL = "public, max-age=0, s-maxage=600, stale-while-revalidate=86400";
app.use((req, res, next) => {
  // HEAD as well as GET: monitors and some crawlers probe with HEAD, and they
  // should see the same cacheability as the GET they mirror. Without this a HEAD
  // fell through to the platform default (max-age=0, must-revalidate).
  if ((req.method === "GET" || req.method === "HEAD") && !req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", CONTENT_CACHE_CONTROL);
  }
  next();
});

// Rendered-HTML cache: the blog and language pages are identical between content
// changes, so the fully rendered HTML is memoised per path. A request becomes a
// map lookup instead of a markdown parse plus template render. Keyed on a cheap
// content signature (file mtimes) so it self-invalidates when a guide changes in
// local dev and never invalidates in production, where the process is short and
// the filesystem static.
const _pageCache = new Map();
function contentSig() {
  let sig = "";
  for (const dir of [path.join(__dirname, "content", "blog"), path.join(__dirname, "content", "blog-es")]) {
    try {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
        sig += `${f}:${fs.statSync(path.join(dir, f)).mtimeMs};`;
      }
    } catch { /* dir may not exist */ }
  }
  try { sig += `index:${fs.statSync(path.join(__dirname, "public", "index.html")).mtimeMs}`; } catch {}
  return sig;
}
function cachedPage(key, build) {
  const sig = contentSig();
  const hit = _pageCache.get(key);
  if (hit && hit.sig === sig) return hit.html;
  const html = build();
  _pageCache.set(key, { sig, html });
  return html;
}

const DUFFEL_API_KEY = process.env.DUFFEL_API_KEY;
const DUFFEL_BASE = "https://api.duffel.com";
const RESEND_API_KEY = process.env.RESEND_API_KEY; // optional — email sending only works once this is set
// Must be an address on the verified *sending* domain (send.peregrin.travel) —
// peregrin.travel itself was left unverified in Resend on purpose, to avoid
// touching the root domain's existing Google Workspace DKIM/DMARC records.
const EMAIL_FROM = process.env.EMAIL_FROM || "Peregrin <reservations@send.peregrin.travel>";

// Stripe collects real money from the *customer*; Duffel's balance is what Peregrin
// then pays the *airline* with. These are two separate legs of the same transaction —
// see payOrderWithDuffelBalance() and the /api/stripe/webhook route below.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
// Stripe, pdfkit, svg-to-pdfkit and qrcode are ~15MB of modules that only the
// payment and PDF routes need, but importing them at the top loaded them on
// every serverless cold start, including for the homepage and blog. They are now
// loaded lazily on first use and cached for the process lifetime, so a content
// request never pays for them. This was a large part of the TTFB regression.
const stripeConfigured = Boolean(STRIPE_SECRET_KEY);
let _stripe;
async function getStripe() {
  if (!stripeConfigured) return null;
  if (!_stripe) {
    const mod = await import("stripe");
    _stripe = new mod.default(STRIPE_SECRET_KEY);
  }
  return _stripe;
}

let _pdfDeps;
async function getPdfDeps() {
  if (!_pdfDeps) {
    const [pdfkit, svg, qrcode] = await Promise.all([
      import("pdfkit"),
      import("svg-to-pdfkit"),
      import("qrcode"),
    ]);
    _pdfDeps = { PDFDocument: pdfkit.default, SVGtoPDF: svg.default, QRCode: qrcode.default };
  }
  return _pdfDeps;
}

// ---------- Peregrin's own retail pricing for the HOLD product ----------
// This is what the customer pays *Peregrin* for the held reservation and its
// document — it is NOT the airline fare. Most customers never proceed to a real
// ticket, so this fee is the actual product (docs/BUSINESS_PLAN.md §1, §3).
//
// CURRENCY NOTE: the Duffel account is AUD-denominated, so offer/fare amounts
// come back as AUD. This fee is deliberately priced and charged in USD because
// §3 benchmarks it against USD-priced competitors (onwardticket.com at $16 flat).
// That means the hold fee (USD) and the optional confirm-to-fly fare (AUD) are
// charged in different currencies — flagged for Liam in NOTES-FOR-LIAM.md, and
// changeable here in one place if he'd rather align them.
const HOLD_FEE_CURRENCY = process.env.HOLD_FEE_CURRENCY || "USD";
const HOLD_FEE_STANDARD = Number(process.env.HOLD_FEE_STANDARD || 14.99);
const HOLD_FEE_MULTI = Number(process.env.HOLD_FEE_MULTI || 19.99);

// One flat, all-in price — no itemised "service fee" line and no card surcharge.
// That's both the best-converting pattern and the only cleanly compliant one in
// the EU and Australia (docs/BUSINESS_PLAN.md §9).
function holdFeeForSliceCount(sliceCount) {
  return sliceCount > 1 ? HOLD_FEE_MULTI : HOLD_FEE_STANDARD;
}

// ---------- "Honour the flight": paid ticket conversion ----------
// Charges airfare + a service fee via Stripe and only THEN issues the ticket.
//
// OFF BY DEFAULT AND MUST STAY OFF IN PRODUCTION until (1) Duffel live hold
// orders are enabled, (2) live issuance is tested end to end, and (3) the
// charge-before-issue + refund-on-failure path is exercised in test mode.
// This buys a real ticket with real money, so the flag is the safety catch.
//
// Note this is the opposite of the free /confirm demo path (gated to test mode):
// there, Peregrin paid the airline out of its own balance. Here the customer pays
// first and issuance is gated on that payment.
const ENABLE_TICKET_CONVERSION = process.env.ENABLE_TICKET_CONVERSION === "true";

// ---------------------------------------------------------------------------
// ANALYTICS
//
// Nothing is collected until credentials are supplied. Each provider is gated
// on its own environment variable, so neither can be switched on by accident
// and either can run without the other:
//
//   PLAUSIBLE_DOMAIN   e.g. "peregrin.travel"   site-wide pageviews, cookieless
//   POSTHOG_KEY        project API key          product events
//   POSTHOG_HOST       optional, defaults to EU
//
// PostHog is deliberately configured with in-memory persistence and session
// recording off. Its defaults write a cookie and record sessions, which would
// need a consent banner and would contradict a privacy policy that currently
// says nothing about analytics. Memory persistence loses returning-visitor
// attribution, which is the honest trade for not needing consent. One line to
// change if that trade is not wanted.
// ---------------------------------------------------------------------------
// Travelpayouts Drive affiliate auto-link script (marker 555961). Unlike the
// analytics providers below it is NOT env-gated: Travelpayouts' "Check Drive
// connection" probe fetches the live homepage and looks for this exact tag, so
// it must always ship. Attributes are verbatim from Travelpayouts (they tell
// caching/optimising proxies not to touch it); do not reformat them.
const TRAVELPAYOUTS_TAG = `<script nowprocket data-noptimize="1" data-cfasync="false" data-wpfc-render="false" seraph-accel-crit="1" data-no-defer="1">
(function () {
var script = document.createElement("script");
script.async = 1;
script.src = 'https://tp-em.com/NTU1OTYx.js?t=555961';
document.head.appendChild(script);
})();
</script>`;

const PLAUSIBLE_DOMAIN = process.env.PLAUSIBLE_DOMAIN || "";
const POSTHOG_KEY = process.env.POSTHOG_KEY || "";
const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://eu.i.posthog.com";

const PLAUSIBLE_TAG = PLAUSIBLE_DOMAIN
  ? `<script defer data-domain="${esc(PLAUSIBLE_DOMAIN)}" src="https://plausible.io/js/script.js"></script>`
  : "";

const POSTHOG_TAG = POSTHOG_KEY
  ? `<script>!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures getActiveMatchingSurveys getSurveys".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
posthog.init(${JSON.stringify(POSTHOG_KEY)},{api_host:${JSON.stringify(POSTHOG_HOST)},persistence:"memory",disable_session_recording:true,capture_pageview:true});</script>`
  : "";

// Vendor-neutral shim. Application code calls peregrinTrack(name, props) and
// never touches a provider directly, so swapping or removing a provider is a
// change here and nowhere else. It is always defined, so an event call is a
// no-op rather than a ReferenceError when analytics is off. That matters: this
// is the exact assumed-global failure mode documented in CLAUDE.md.
const ANALYTICS_SHIM = `<script>
window.peregrinTrack = function (name, props) {
  try {
    if (window.posthog && typeof window.posthog.capture === "function") window.posthog.capture(name, props || {});
    if (typeof window.plausible === "function") window.plausible(name, props ? { props: props } : undefined);
  } catch (e) { /* analytics must never break the page */ }
};
</script>`;

// TRAVELPAYOUTS_TAG rides along here because this constant is already injected
// into the head of every served page (homepage + language pages, blog, faq,
// verify, privacy, sample, onward-ticket) — one list, no page left out.
const ANALYTICS_TAG = [TRAVELPAYOUTS_TAG, PLAUSIBLE_TAG, POSTHOG_TAG, ANALYTICS_SHIM].filter(Boolean).join("\n");
const ANALYTICS_ON = Boolean(PLAUSIBLE_TAG || POSTHOG_TAG);
setBlogHeadExtra(ANALYTICS_TAG);
const CONVERSION_FEE_FLAT = Number(process.env.CONVERSION_FEE_FLAT || 29.0);
const CONVERSION_FEE_PCT = Number(process.env.CONVERSION_FEE_PCT || 0.07);

// Service fee is the greater of a floor and a percentage, so small fares still
// clear costs and large fares scale. Rounded to cents.
function conversionServiceFee(airfare) {
  const fare = Number(airfare) || 0;
  return Math.round(Math.max(CONVERSION_FEE_FLAT, CONVERSION_FEE_PCT * fare) * 100) / 100;
}

function conversionQuote(airfare, currency) {
  const fare = Math.round((Number(airfare) || 0) * 100) / 100;
  const fee = conversionServiceFee(fare);
  return {
    airfare: fare,
    service_fee: fee,
    total: Math.round((fare + fee) * 100) / 100,
    currency: (currency || "USD").toUpperCase(),
  };
}

// Duffel test keys are prefixed `duffel_test_`, live keys `duffel_live_`. This is
// the single source of truth for the dev-only test-mode badge in the UI — only the
// resulting boolean is ever sent to the browser, never the key.
const DUFFEL_TEST_MODE = String(DUFFEL_API_KEY || "").startsWith("duffel_test_");

if (!DUFFEL_API_KEY) {
  console.warn("WARNING: DUFFEL_API_KEY is not set. Set it in .env before making live calls.");
}
if (!stripeConfigured) {
  console.warn("WARNING: STRIPE_SECRET_KEY is not set. /api/order/:id/checkout will return 501 until it is.");
}

// The Stripe webhook needs the *raw* request body to verify its signature, so this
// route (and its own express.raw() body parser) must be registered before the global
// express.json() below — Express matches routes in registration order, so this one
// claims the request first and the JSON parser never touches it.
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripeConfigured || !STRIPE_WEBHOOK_SECRET) {
    console.warn("Stripe webhook received but STRIPE_WEBHOOK_SECRET is not configured — ignoring.");
    return res.status(501).send("Stripe webhook not configured");
  }
  const stripe = await getStripe();

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orderId = session.metadata?.order_id;
    // Two DIFFERENT products can be paid for against the same order, and they must
    // never be conflated:
    //   purpose "hold_fee" -> customer bought the held reservation + its document.
    //                         Peregrin keeps this. The airline is NOT paid, and the
    //                         hold still lapses on its own if never confirmed.
    //   purpose "fare"     -> customer chose to actually fly, so Peregrin now pays
    //                         the airline via Duffel balance to issue a real ticket.
    // Sessions created before this split carry no `purpose`; those were all fare
    // payments, so an absent purpose intentionally falls through to the fare path.
    const purpose = session.metadata?.purpose || "fare";
    if (orderId) {
      if (purpose === "hold_fee") {
        markHoldFeePaid(orderId);
        console.log(`Hold fee paid for order ${orderId} (Stripe ${session.id}) — document unlocked, airline NOT paid.`);
      } else if (purpose === "ticket_conversion") {
        // Customer chose to fly and has paid airfare + service fee. Issue only
        // now, and only if the flag is on — a stray webhook must never cause an
        // issuance while the feature is disabled.
        if (!ENABLE_TICKET_CONVERSION) {
          console.error(`Ticket-conversion webhook for ${orderId} while the feature is disabled — refusing to issue.`);
        } else {
          await issueTicketAfterPayment(orderId, session);
        }
      } else {
        // Customer has genuinely paid Peregrin via Stripe at this point. Peregrin now
        // pays the airline via Duffel's balance to actually ticket the reservation —
        // this mirrors the real production flow (customer -> Peregrin -> airline).
        // Routed through issueTicketAfterPayment (not payOrderWithDuffelBalance
        // directly) so this path gets the same guarantees as ticket conversion:
        // idempotent against webhook retries, and an automatic full refund if
        // ticketing fails — a charge must never survive a failed issuance.
        await issueTicketAfterPayment(orderId, session);
      }
    }
  }

  res.json({ received: true });
});

app.use(express.json());

// The Help / FAQ page is a client-rendered route served by the same single-page
// file — the inline script reads location.pathname and shows the FAQ view.
// Registered before the static middleware so /faq resolves to index.html.
// /faq is a view of the same single-page app, so it is served through the same
// renderer as the homepage rather than sending the raw file. Sending the file
// directly skipped the analytics shim and the hreflang cluster, and left the
// internal-links placeholder unfilled.
app.get("/faq", (req, res) =>
  res.type("html").send(
    cachedPage("/faq", () =>
      renderIndexForLang("en", {
        origin: SITE_ORIGIN,
        // FAQPage JSON-LD is generated from the same faqData the page renders,
        // so the schema and the visible answers cannot drift apart.
        headExtra: ANALYTICS_TAG + faqPageSchema("en"),
        homeLinks: seoLinksHtml("/", { heading: "Popular guides" }),
        canonicalPath: "/faq",
        includeHreflang: false,
      })
    )
  )
);

// ---------- Blog ----------
// Server-rendered so it's fast and crawlable — this is the traffic engine, so it
// must not depend on client JS. Publishing a new guide is dropping a .md into
// content/blog/, no code change.
// Blog RSS feed, so readers and aggregators can subscribe and search engines
// have another discovery path. English guides only (the feed is one language);
// newest first, matching the index. Cached by the CDN like other content.
app.get("/blog/feed.xml", (req, res) => {
  const articles = listArticles("en");
  const esc = (v) =>
    String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const rfc822 = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? new Date().toUTCString() : d.toUTCString();
  };
  const items = articles.map((a) => {
    const url = `${SITE_ORIGIN}/blog/${a.slug}`;
    return `    <item>
      <title>${esc(a.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <pubDate>${rfc822(a.date)}</pubDate>
      <description>${esc(a.description)}</description>
    </item>`;
  }).join("\n");
  const latest = articles[0] ? rfc822(articles[0].date) : new Date().toUTCString();
  res.type("application/rss+xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Peregrin Guides</title>
    <link>${SITE_ORIGIN}/blog</link>
    <atom:link href="${SITE_ORIGIN}/blog/feed.xml" rel="self" type="application/rss+xml" />
    <description>Practical guides to proof of onward travel, visas and entry rules by country.</description>
    <language>en</language>
    <lastBuildDate>${latest}</lastBuildDate>
${items}
  </channel>
</rss>
`
  );
});

// One place that knows which guides exist in each language, so the language
// context (base paths, chrome, hreflang pairing, dead-link neutralisation) is
// built the same way for every blog route.
function blogCtx(lang) {
  return buildBlogCtx(lang, { enSlugs: guideSlugs("en"), esSlugs: guideSlugs("es"), origin: SITE_ORIGIN });
}

// Visa hub: the by-country overview. Registered before /blog/:slug so the
// static path wins over the slug matcher.
app.get(VISA_HUB_ROUTE, (req, res) => {
  const articles = listArticles("en");
  res.type("html").send(cachedPage(VISA_HUB_ROUTE, () => renderVisaHub(articles, SITE_ORIGIN)));
});

app.get("/blog", (req, res) => {
  res.type("html").send(cachedPage("/blog", () => renderBlogIndex(listArticles("en"), SITE_ORIGIN, blogCtx("en"))));
});

app.get("/blog/:slug", (req, res) => {
  const slug = String(req.params.slug);
  const article = getArticle(slug, "en");
  if (!article) return res.status(404).type("text/plain").send("Not found");
  res.type("html").send(cachedPage(`/blog/${slug}`, () => renderArticle(article, listArticles("en"), SITE_ORIGIN, blogCtx("en"))));
});

// Spanish guide section. Same renderer, Spanish context: /es/blog base, Spanish
// chrome, lang=es, self-canonical, hreflang pairing by slug.
app.get("/es/blog", (req, res) => {
  res.type("html").send(cachedPage("/es/blog", () => renderBlogIndex(listArticles("es"), SITE_ORIGIN, blogCtx("es"))));
});

app.get("/es/blog/:slug", (req, res) => {
  const slug = String(req.params.slug);
  const article = getArticle(slug, "es");
  if (!article) return res.status(404).type("text/plain").send("Not found");
  res.type("html").send(cachedPage(`/es/blog/${slug}`, () => renderArticle(article, listArticles("es"), SITE_ORIGIN, blogCtx("es"))));
});

// ---------- Privacy policy ----------
// The policy TEXT lives in PRIVACY_POLICY.md next to this file and is
// deliberately not written in code: it is a legal document and must be authored
// and reviewed as one, not paraphrased by the app.
//
// If that file is absent the route 404s and the footer link stays hidden, so a
// half-finished policy can never be published. Drop the .md in and it goes live
// with no code change.
const PRIVACY_PATH = path.join(__dirname, "PRIVACY_POLICY.md");
const PRIVACY_LAST_UPDATED = process.env.PRIVACY_LAST_UPDATED || "24 July 2026";

function readPrivacyPolicy() {
  // Read per request rather than at boot so adding the file doesn't need a restart.
  try {
    const raw = fs.readFileSync(PRIVACY_PATH, "utf8").trim();
    return raw.length ? raw : null;
  } catch {
    return null;
  }
}

// Small Markdown subset renderer — headings, paragraphs, lists, bold/italic,
// links and rules. Input is escaped first, so nothing in the source file can
// inject markup.
function renderMarkdown(md) {
  const inline = (t) =>
    esc(t)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+|\/[^\s)]*)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");

  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) { closeList(); continue; }
    if (/^---+$/.test(line)) { closeList(); out.push("<hr>"); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); const lvl = h[1].length; out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); continue; }
    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(ul[1])}</li>`); continue; }
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ol) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(ol[1])}</li>`); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}

// ---------- Verify: the destination of the QR code on every reservation PDF ----------
// Deliberately does NOT look a reservation up by its reference. A booking
// reference is printed on a document anyone might handle, so resolving one to
// passenger details here would leak personal data to whoever scans the code.
// Instead the page explains how to check the reservation against the airline
// itself, which is the only verification that actually proves anything.
app.get("/verify", (req, res) => {
  const ref = String(req.query.ref || "").trim().toUpperCase().slice(0, 12);
  const safeRef = /^[A-Z0-9]{5,8}$/.test(ref) ? ref : "";

  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Verify a reservation | Peregrin</title>
<meta name="robots" content="noindex">
<link rel="canonical" href="${esc(SITE_ORIGIN)}/verify">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Peregrin">
<meta property="og:title" content="Verify a reservation | Peregrin">
<meta property="og:description" content="Check a Peregrin reservation code directly with the airline that holds the booking.">
<meta property="og:url" content="${esc(SITE_ORIGIN)}/verify">
<meta property="og:image" content="${esc(SITE_ORIGIN)}/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Verify a reservation | Peregrin">
<meta name="twitter:description" content="Check a Peregrin reservation code directly with the airline that holds the booking.">
<meta name="twitter:image" content="${esc(SITE_ORIGIN)}/og-image.png">
${ANALYTICS_TAG}
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#16283a">
<style>
  :root { --ink:#16283a; --muted:#5c6b7c; --line:#e2e7ec; --bg:#f8f9fb; --accent:#1c6f8c;
    --accent-bg:#e8f2f5; --gold:#c9922e; --gold-bg:#faf1e0; }
  @font-face { font-family:'Public Sans'; font-weight:400; font-display:swap; src:url('/fonts/publicsans-400-latin.woff2') format('woff2'); }
  @font-face { font-family:'Public Sans'; font-weight:600; font-display:swap; src:url('/fonts/publicsans-600-latin.woff2') format('woff2'); }
  @font-face { font-family:'Public Sans'; font-weight:700; font-display:swap; src:url('/fonts/publicsans-700-latin.woff2') format('woff2'); }
  @font-face { font-family:'Source Serif 4'; font-weight:700; font-display:swap; src:url('/fonts/sourceserif4-700-latin.woff2') format('woff2'); }
  * { box-sizing:border-box; }
  body { margin:0; background:radial-gradient(1100px 420px at 50% -140px, var(--accent-bg), transparent 70%), var(--bg);
    color:var(--ink); font-family:"Public Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased; min-height:100vh; }
  .wrap { max-width:640px; margin:0 auto; padding:0 24px 72px; }
  header { padding:32px 0 22px; display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .brand { display:flex; align-items:center; gap:10px; text-decoration:none; color:inherit; }
  .mark { font-size:17px; font-weight:800; letter-spacing:.05em; text-transform:uppercase; }
  .header-link { font-size:13px; color:var(--muted); text-decoration:none; }
  h1 { font-family:"Source Serif 4",Georgia,serif; font-size:26px; line-height:1.2; margin:0 0 10px; }
  .lede { font-size:15px; color:var(--muted); line-height:1.55; margin:0 0 26px; }
  .refcard { background:#fff; border:1px solid var(--line); border-radius:14px; padding:22px 24px; margin:0 0 20px;
    box-shadow:0 1px 2px rgba(16,32,45,.04), 0 10px 28px rgba(16,32,45,.035); }
  .reflabel { font-size:11px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; color:var(--accent); margin:0 0 8px; }
  .refcode { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:30px; font-weight:700; letter-spacing:.08em; margin:0; }
  .steps { background:#fff; border:1px solid var(--line); border-radius:14px; padding:8px 24px; margin:0 0 20px; }
  .steps li { padding:14px 0; border-bottom:1px solid var(--line); font-size:14px; line-height:1.6; color:var(--ink); }
  .steps li:last-child { border-bottom:none; }
  .steps strong { display:block; margin-bottom:2px; }
  .steps span { color:var(--muted); }
  ol.steps { list-style:none; counter-reset:s; padding-left:24px; }
  ol.steps li { counter-increment:s; position:relative; }
  ol.steps li::before { content:counter(s); position:absolute; left:-26px; top:16px; width:18px; height:18px;
    border-radius:50%; background:var(--accent-bg); color:var(--accent); font-size:11px; font-weight:700;
    display:flex; align-items:center; justify-content:center; }
  .note { background:var(--gold-bg); border:1px solid #ecd9ad; border-left:3px solid var(--gold); border-radius:12px;
    padding:16px 20px; font-size:13px; line-height:1.6; color:#6d4d12; margin:0 0 24px; }
  a.back { display:inline-block; font-size:13px; color:var(--accent); text-decoration:none; }
  footer { margin-top:36px; padding-top:20px; border-top:1px solid var(--line); font-size:12px; color:var(--muted); }
  footer a { color:var(--muted); }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <a class="brand" href="/"><span class="mark">Peregrin</span></a>
      <a class="header-link" href="/faq">Help &amp; FAQ</a>
    </header>

    <h1>Verify this reservation</h1>
    <p class="lede">Peregrin reservations are genuine bookings held in an airline's own system. That means you do not
      have to take our word for it, and you should not have to: the airline can confirm it directly.</p>

    ${safeRef ? `<div class="refcard">
      <p class="reflabel">Reservation code</p>
      <p class="refcode">${esc(safeRef)}</p>
    </div>` : ""}

    <ol class="steps">
      <li><strong>Check it with the airline</strong><span>Enter the reservation code and the passenger surname into the
        operating airline's "manage booking" page, or read it to their reservations line. The airline holds the record,
        so their answer is the authoritative one.</span></li>
      <li><strong>Or use a neutral lookup</strong><span>Global tools such as CheckMyTrip and TripCase read the same
        underlying booking record from the code alone.</span></li>
      <li><strong>Or ask us</strong><span>Email <a href="mailto:hello@peregrin.travel">hello@peregrin.travel</a> with the
        reservation code and we will confirm what we hold.</span></li>
    </ol>

    <p class="note">A Peregrin reservation is a held booking, not a purchased ticket. It is confirmed with the airline and
      can be verified, and it lapses automatically under the fare's own terms if it is not paid for and confirmed. A
      ticket is only issued if and when payment is completed.</p>

    <a class="back" href="/">&larr; Back to Peregrin</a>

    <footer>
      <a href="/">Peregrin</a> &middot; <a href="/faq">Help &amp; FAQ</a> &middot;
      <a href="/privacy">Privacy</a> &middot; <a href="mailto:hello@peregrin.travel">hello@peregrin.travel</a>
    </footer>
  </div>
</body>
</html>`);
});

app.get("/privacy", (req, res) => {
  const md = readPrivacyPolicy();
  if (!md) {
    // No policy text on disk — better a clean 404 than a page of placeholders.
    return res.status(404).type("text/plain").send("Not found");
  }
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Privacy Policy | Peregrin</title>
<meta name="description" content="How Peregrin collects, uses, and protects your personal information when you use our reservation service.">
<link rel="canonical" href="${esc(SITE_ORIGIN)}/privacy">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Peregrin">
<meta property="og:title" content="Privacy Policy | Peregrin">
<meta property="og:description" content="How Peregrin collects, uses, and protects your personal information when you use our reservation service.">
<meta property="og:url" content="${esc(SITE_ORIGIN)}/privacy">
<meta property="og:image" content="${esc(SITE_ORIGIN)}/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Privacy Policy | Peregrin">
<meta name="twitter:description" content="How Peregrin collects, uses, and protects your personal information when you use our reservation service.">
<meta name="twitter:image" content="${esc(SITE_ORIGIN)}/og-image.png">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Privacy Policy","url":"${esc(SITE_ORIGIN)}/privacy"}</script>
${ANALYTICS_TAG}
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Privacy Policy","url":"${esc(SITE_ORIGIN)}/privacy"}</script>
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#16283a">
<style>
  :root { --ink:#16283a; --muted:#5c6b7c; --line:#e2e7ec; --bg:#f8f9fb; --accent:#1c6f8c;
    --accent-bg:#e8f2f5; --accent-dark:#124a5e; --gold:#c9922e; --gold-bg:#faf1e0; }
  @font-face { font-family:'Public Sans'; font-weight:400; font-display:swap; src:url('/fonts/publicsans-400-latin.woff2') format('woff2'); }
  @font-face { font-family:'Public Sans'; font-weight:600; font-display:swap; src:url('/fonts/publicsans-600-latin.woff2') format('woff2'); }
  @font-face { font-family:'Public Sans'; font-weight:700; font-display:swap; src:url('/fonts/publicsans-700-latin.woff2') format('woff2'); }
  @font-face { font-family:'Source Serif 4'; font-weight:700; font-display:swap; src:url('/fonts/sourceserif4-700-latin.woff2') format('woff2'); }
  * { box-sizing:border-box; }
  body { margin:0; color:var(--ink); background:radial-gradient(1100px 420px at 50% -140px, var(--accent-bg), transparent 70%), var(--bg);
    font-family:"Public Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:760px; margin:0 auto; padding:0 24px 70px; }
  header { padding:26px 0 18px; display:flex; align-items:center; justify-content:space-between; }
  .brand { display:flex; align-items:center; gap:10px; text-decoration:none; }
  .mark { font-size:17px; font-weight:800; letter-spacing:.05em; text-transform:uppercase; color:var(--ink); }
  .header-link { display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:600; text-decoration:none;
    color:var(--accent-dark); background:var(--accent-bg); border:1px solid #cfe4ea; border-radius:100px; padding:5px 14px; }
  h1 { font-family:"Source Serif 4",Georgia,serif; font-size:29px; margin:0 0 6px; letter-spacing:-.015em; }
  .updated { font-size:12.5px; color:var(--muted); margin:0 0 26px; }
  .doc { background:#fff; border:1px solid var(--line); border-radius:14px; padding:30px 34px;
    box-shadow:0 1px 2px rgba(16,32,45,.04), 0 10px 28px rgba(16,32,45,.035); }
  .doc h1 { font-size:23px; margin:0 0 12px; }
  .doc h2 { font-family:"Source Serif 4",Georgia,serif; font-size:18px; margin:28px 0 8px; }
  .doc h3 { font-size:14.5px; margin:20px 0 6px; }
  .doc h4 { font-size:13.5px; margin:16px 0 6px; }
  .doc p, .doc li { font-size:14px; line-height:1.7; color:#2b3b4c; }
  .doc p { margin:0 0 12px; }
  .doc ul, .doc ol { margin:0 0 14px; padding-left:22px; }
  .doc li { margin-bottom:6px; }
  .doc a { color:var(--accent); }
  .doc hr { border:0; border-top:1px solid var(--line); margin:22px 0; }
  .back { display:inline-block; margin-top:22px; font-size:13px; color:var(--accent); text-decoration:none; }
  .seo-links { max-width:760px; margin:26px auto 0; padding:16px 20px; background:#fff;
    border:1px solid var(--line); border-radius:12px; text-align:left; }
  .seo-links-h { margin:0 0 8px; font-size:11px; font-weight:700; letter-spacing:.08em;
    text-transform:uppercase; color:var(--accent); }
  .seo-links a { display:block; font-size:13.5px; font-weight:600; color:var(--ink);
    text-decoration:none; padding:7px 0; border-top:1px solid var(--line); }
  .seo-links a:first-of-type { border-top:none; padding-top:0; }
  .seo-links a:hover { color:var(--accent); }
  footer { border-top:1px solid var(--line); margin-top:26px; padding:18px 0; text-align:center; font-size:12px; color:var(--muted); }
  footer a { color:var(--accent); text-decoration:none; }
  @media (max-width:620px){ .doc{padding:20px 18px;} h1{font-size:24px;} }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <a class="brand" href="/">
        <svg width="26" height="26" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <path d="M5 28C11 26 16 20 19 8" stroke="var(--accent)" stroke-width="4" stroke-linecap="round"/>
          <path d="M12 31C18 28 23 22 26 11" stroke="var(--accent)" stroke-width="4" stroke-linecap="round" opacity="0.55"/>
          <path d="M19 34C25 31 29 25 32 15" stroke="var(--gold)" stroke-width="4" stroke-linecap="round"/>
        </svg>
        <span class="mark">Peregrin</span>
      </a>
      <a class="header-link" href="/faq" id="ch-help">Help &amp; FAQ</a>
    </header>

    <h1 id="ch-title">Privacy Policy</h1>
    <p class="updated"><span id="ch-updated">Last updated</span> ${esc(PRIVACY_LAST_UPDATED)}</p>

    <div class="doc">${renderMarkdown(md)}</div>

    <a class="back" href="/" id="ch-back">&larr; Back to Peregrin</a>

    <footer>
      <a href="/">Peregrin</a> · <a href="/faq" id="ch-help2">Help &amp; FAQ</a> · <a href="mailto:hello@peregrin.travel">hello@peregrin.travel</a>
    </footer>
  </div>
<script>
  // Page chrome follows the language chosen on the main site. The policy body
  // itself stays English for now — it is a legal text and needs a real
  // translation, not a machine one.
  (function () {
    var C = {
      en: { title: "Privacy Policy", updated: "Last updated", back: "\\u2190 Back to Peregrin", help: "Help & FAQ" },
      es: { title: "Pol\\u00edtica de Privacidad", updated: "\\u00daltima actualizaci\\u00f3n", back: "\\u2190 Volver a Peregrin", help: "Ayuda y preguntas frecuentes" },
      ru: { title: "\\u041f\\u043e\\u043b\\u0438\\u0442\\u0438\\u043a\\u0430 \\u043a\\u043e\\u043d\\u0444\\u0438\\u0434\\u0435\\u043d\\u0446\\u0438\\u0430\\u043b\\u044c\\u043d\\u043e\\u0441\\u0442\\u0438", updated: "\\u041e\\u0431\\u043d\\u043e\\u0432\\u043b\\u0435\\u043d\\u043e", back: "\\u2190 \\u041d\\u0430\\u0437\\u0430\\u0434 \\u0432 Peregrin", help: "\\u041f\\u043e\\u043c\\u043e\\u0449\\u044c" },
      hi: { title: "\\u0917\\u094b\\u092a\\u0928\\u0940\\u092f\\u0924\\u093e \\u0928\\u0940\\u0924\\u093f", updated: "\\u0905\\u0902\\u0924\\u093f\\u092e \\u0905\\u092a\\u0921\\u0947\\u091f", back: "\\u2190 Peregrin \\u092a\\u0930 \\u0935\\u093e\\u092a\\u0938", help: "\\u0938\\u0939\\u093e\\u092f\\u0924\\u093e" }
    };
    var lang = "en";
    try { lang = localStorage.getItem("peregrin_lang") || "en"; } catch (e) {}
    var t = C[lang] || C.en;
    document.documentElement.lang = lang;
    var set = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
    set("ch-title", t.title);
    set("ch-updated", t.updated);
    set("ch-back", t.back);
    set("ch-help", t.help);
    set("ch-help2", t.help);
  })();
</script>
</body>
</html>`);
});

// ---------- Sample reservation (static, no supplier call) ----------
// Shows what the document looks like before anyone pays. Entirely hard-coded and
// watermarked: obviously-example data, an impossible-to-mistake PNR, and no
// Duffel call whatsoever — so it costs nothing and can never leak a real booking.
// Static specimen data for /sample-reservation. Deliberately invented and
// deliberately never sent to Duffel: this page is a sales tool, so it must load
// instantly and must not consume a real offer request. The routing is a
// believable Thai Airways round trip so the layout reads like the real
// document a customer receives.
// Default specimen carrier is Thai Airways: a carrier we genuinely return offers
// for on BKK routes, so the sample reads like a document a customer would really
// receive. Thai flies BKK<->SYD direct, so the specimen is a clean one-stop-free
// round trip.
const SAMPLE = {
  city: "Sydney",
  pnr: "SAMPLE",
  carrier: "Thai Airways",
  carrier_iata: "TG",
  passenger: "SAMPLE TRAVELLER",
  issued: "Fri, 24 Jul 2026",
  slices: [
    {
      label: "Outbound",
      segments: [
        {
          flight: "TG475", cabin: "Economy", aircraft: "Boeing 787-9",
          from_iata: "BKK", from_city: "Bangkok", from_terminal: "1",
          to_iata: "SYD", to_city: "Sydney", to_terminal: "1",
          date: "Sat, 15 Aug 2026", dep: "20:15", arr_date: "Sun, 16 Aug 2026", arr: "09:30",
          duration: "9h 15m", layover: "",
        },
      ],
    },
    {
      label: "Return",
      segments: [
        {
          flight: "TG476", cabin: "Economy", aircraft: "Boeing 787-9",
          from_iata: "SYD", from_city: "Sydney", from_terminal: "1",
          to_iata: "BKK", to_city: "Bangkok", to_terminal: "1",
          date: "Sun, 06 Sep 2026", dep: "16:05", arr_date: "Sun, 06 Sep 2026", arr: "21:35",
          duration: "9h 30m", layover: "",
        },
      ],
    },
  ],
};

// Maps the static SAMPLE specimen into the exact order shape renderReservationPdf
// expects, so the sample PDF exercises the real document generator (not a second
// codepath) while never touching Duffel. The specimen watermark and the SAMPLE
// booking reference make it unmistakably an example.
function sampleOrderForPdf() {
  return {
    booking_reference: SAMPLE.pnr,
    airline: SAMPLE.carrier,
    airline_iata: SAMPLE.carrier_iata,
    awaiting_payment: true,
    created_at: "2026-07-24T09:00:00Z",
    route_summary: "BKK → SYD → BKK",
    passenger_names: [SAMPLE.passenger],
    itinerary: SAMPLE.slices.map((s) => ({
      segments: s.segments.map((seg) => ({
        flight_number: seg.flight,
        airline: SAMPLE.carrier,
        aircraft: seg.aircraft,
        cabin: seg.cabin,
        origin_iata: seg.from_iata,
        destination_iata: seg.to_iata,
        origin_name: seg.from_city,
        destination_name: seg.to_city,
        origin_terminal: seg.from_terminal,
        destination_terminal: seg.to_terminal,
        departure_date: seg.date,
        departure_time: seg.dep,
        arrival_date: seg.arr_date,
        arrival_time: seg.arr,
        duration: seg.duration,
        layover_after: seg.layover
          ? { label: seg.layover.split(" in ")[0], airport: seg.layover.split(" in ")[1] || "" }
          : null,
      })),
    })),
  };
}

function sampleSegment(seg) {
  return `
      <div class="seg">
        <div class="seg-top">
          <img class="seg-logo" src="/img/sample-carrier-logo.svg" alt="${esc(SAMPLE.carrier)}" width="26" height="26">
          <div>
            <b>${esc(seg.flight)} &middot; ${esc(SAMPLE.carrier)}</b>
            <span>${esc(seg.aircraft)} &middot; ${esc(seg.cabin)}</span>
          </div>
        </div>
        <div class="seg-row">
          <div class="seg-col">
            <b>${esc(seg.from_iata)}</b>
            <span>${esc(seg.from_city)} (Terminal ${esc(seg.from_terminal)})</span>
            <span>${esc(seg.date)} &middot; ${esc(seg.dep)}</span>
          </div>
          <div class="seg-mid"><span>${esc(seg.duration)}</span><i></i></div>
          <div class="seg-col r">
            <b>${esc(seg.to_iata)}</b>
            <span>${esc(seg.to_city)} (Terminal ${esc(seg.to_terminal)})</span>
            <span>${esc(seg.arr_date)} &middot; ${esc(seg.arr)}</span>
          </div>
        </div>
      </div>
      ${seg.layover ? `<p class="layover">Layover: ${esc(seg.layover)}</p>` : ""}`;
}

app.get("/sample-reservation", (req, res) => {
  const d = SAMPLE;
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>See a Sample Flight Reservation (Real PNR) | Peregrin</title>
<meta name="description" content="See exactly what a Peregrin reservation looks like: a real airline booking reference you can verify, formatted as proof for a visa and airline check-in.">
<link rel="canonical" href="${esc(SITE_ORIGIN)}/sample-reservation">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Peregrin">
<meta property="og:title" content="See a Sample Flight Reservation (Real PNR) | Peregrin">
<meta property="og:description" content="See exactly what a Peregrin reservation looks like: a real airline booking reference you can verify.">
<meta property="og:url" content="${esc(SITE_ORIGIN)}/sample-reservation">
<meta property="og:image" content="${esc(SITE_ORIGIN)}/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="See a Sample Flight Reservation (Real PNR) | Peregrin">
<meta name="twitter:description" content="See exactly what a Peregrin reservation looks like: a real airline booking reference you can verify.">
<meta name="twitter:image" content="${esc(SITE_ORIGIN)}/og-image.png">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"A sample reservation","url":"${esc(SITE_ORIGIN)}/sample-reservation"}</script>
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#16283a">
${ANALYTICS_TAG}
<style>
  :root { --ink:#16283a; --muted:#5c6b7c; --line:#e2e7ec; --bg:#f8f9fb; --accent:#1c6f8c;
    --accent-bg:#e8f2f5; --accent-dark:#124a5e; --gold:#c9922e; --gold-bg:#faf1e0; --success:#1f7a5c; --success-bg:#e7f4ee; }
  @font-face { font-family:'Public Sans'; font-weight:400; font-display:swap; src:url('/fonts/publicsans-400-latin.woff2') format('woff2'); }
  @font-face { font-family:'Public Sans'; font-weight:600; font-display:swap; src:url('/fonts/publicsans-600-latin.woff2') format('woff2'); }
  @font-face { font-family:'Public Sans'; font-weight:700; font-display:swap; src:url('/fonts/publicsans-700-latin.woff2') format('woff2'); }
  @font-face { font-family:'Source Serif 4'; font-weight:700; font-display:swap; src:url('/fonts/sourceserif4-700-latin.woff2') format('woff2'); }
  * { box-sizing:border-box; }
  body { margin:0; color:var(--ink); background:radial-gradient(1100px 420px at 50% -140px, var(--accent-bg), transparent 70%), var(--bg);
    font-family:"Public Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:760px; margin:0 auto; padding:0 24px 70px; }
  header { padding:26px 0 18px; display:flex; align-items:center; justify-content:space-between; }
  .brand { display:flex; align-items:center; gap:10px; text-decoration:none; }
  .mark { font-size:17px; font-weight:800; letter-spacing:.05em; text-transform:uppercase; color:var(--ink); }
  .header-link { display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:600; text-decoration:none;
    color:var(--accent-dark); background:var(--accent-bg); border:1px solid #cfe4ea; border-radius:100px; padding:5px 14px; }
  h1 { font-family:"Source Serif 4",Georgia,serif; font-size:27px; margin:0 0 8px; letter-spacing:-.015em; }
  .lede { font-size:14.5px; color:var(--muted); margin:0 0 22px; line-height:1.55; }
  .banner { background:var(--gold-bg); border:1px solid #ecd9ad; border-left:3px solid var(--gold); border-radius:12px;
    padding:14px 18px; margin-bottom:22px; font-size:13px; color:#7a5a1d; line-height:1.55; }
  .doc { position:relative; overflow:hidden; background:#fff; border:1px solid var(--line); border-radius:14px;
    padding:30px 32px; box-shadow:0 1px 2px rgba(16,32,45,.04), 0 10px 28px rgba(16,32,45,.035); }
  /* Watermark tiled across the WHOLE document, not a single stamp, so no crop or
     screenshot of any part of it can read as a real reservation. */
  .wm { position:absolute; inset:-25%; pointer-events:none; user-select:none; z-index:2;
    display:flex; flex-direction:column; justify-content:space-around; transform:rotate(-24deg); }
  .wm span { font-family:"Source Serif 4",Georgia,serif; font-size:60px; font-weight:700; letter-spacing:.14em;
    color:rgba(28,111,140,.13); white-space:nowrap; text-align:center; }
  .doc > *:not(.wm) { position:relative; z-index:1; }
  .doc-head { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap;
    border-bottom:1px solid var(--line); padding-bottom:16px; margin-bottom:18px; }
  .doc-title { font-family:"Source Serif 4",Georgia,serif; font-size:21px; font-weight:700; margin:0 0 4px; }
  .doc-sub { font-size:12.5px; color:var(--muted); margin:0; display:flex; align-items:center; gap:8px; }
  .pnr-label { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; margin-bottom:3px; }
  .pnr { font-family:ui-monospace,"SF Mono",monospace; font-size:20px; font-weight:700; letter-spacing:.08em; color:var(--accent-dark); }
  .status { display:inline-flex; align-items:center; gap:7px; background:var(--success-bg); border:1px solid #c3e2d1;
    color:#14543d; border-radius:100px; padding:6px 14px; font-size:12.5px; font-weight:700; margin-bottom:18px; }
  .slice-label { font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin:14px 0 8px; }
  .seg { border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:10px; }
  .seg-top { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
  .seg-top b { display:block; font-size:13px; font-weight:700; }
  .seg-top span { display:block; font-size:11.5px; color:var(--muted); }
  .seg-logo { flex-shrink:0; border-radius:4px; }
  .seg-row { display:flex; justify-content:space-between; align-items:flex-start; gap:14px; }
  .seg-col { min-width:0; }
  .seg-col b { display:block; font-size:19px; font-weight:700; }
  .seg-col span { display:block; font-size:12px; color:var(--muted); }
  .seg-col.r { text-align:right; }
  .seg-mid { flex:1; text-align:center; padding-top:6px; }
  .seg-mid span { display:block; font-size:11px; color:var(--muted); margin-bottom:4px; }
  .seg-mid i { display:block; height:1px; background:var(--line); }
  .layover { font-size:11.5px; color:var(--muted); font-style:italic; margin:0 0 12px 4px; }
  .rowline { display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid var(--line); font-size:13px; }
  .rowline:last-of-type { border-bottom:none; }
  .rowline span:first-child { color:var(--muted); }
  .fine { margin-top:18px; padding-top:16px; border-top:1px solid var(--line); font-size:11.5px; color:var(--muted); line-height:1.6; }
  .fine p { margin:0 0 7px; }
  .cta { text-align:center; margin-top:26px; }
  .cta p { font-size:14.5px; margin:0 0 12px; }
  .btn { display:inline-block; background:var(--ink); color:#fff; border-radius:8px; padding:12px 24px; font-size:14px; font-weight:700; text-decoration:none; }
  .seo-links { max-width:760px; margin:26px auto 0; padding:16px 20px; background:#fff;
    border:1px solid var(--line); border-radius:12px; text-align:left; }
  .seo-links-h { margin:0 0 8px; font-size:11px; font-weight:700; letter-spacing:.08em;
    text-transform:uppercase; color:var(--accent); }
  .seo-links a { display:block; font-size:13.5px; font-weight:600; color:var(--ink);
    text-decoration:none; padding:7px 0; border-top:1px solid var(--line); }
  .seo-links a:first-of-type { border-top:none; padding-top:0; }
  .seo-links a:hover { color:var(--accent); }
  footer { border-top:1px solid var(--line); margin-top:30px; padding:18px 0; text-align:center; font-size:12px; color:var(--muted); }
  footer a { color:var(--accent); text-decoration:none; }
  @media (max-width:620px){ .doc{padding:20px 18px;} .wm span{font-size:38px;} h1{font-size:22px;}
    .seg-row{flex-direction:column;} .seg-col.r{text-align:left;} .seg-mid{display:none;} }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <a class="brand" href="/">
        <svg width="26" height="26" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <path d="M5 28C11 26 16 20 19 8" stroke="var(--accent)" stroke-width="4" stroke-linecap="round"/>
          <path d="M12 31C18 28 23 22 26 11" stroke="var(--accent)" stroke-width="4" stroke-linecap="round" opacity="0.55"/>
          <path d="M19 34C25 31 29 25 32 15" stroke="var(--gold)" stroke-width="4" stroke-linecap="round"/>
        </svg>
        <span class="mark">Peregrin</span>
      </a>
      <a class="header-link" href="/faq">Help &amp; FAQ</a>
    </header>

    <h1>A sample reservation</h1>
    <p class="lede">This is an example of the document you receive, shown with sample data so you can see exactly what an airline, embassy or check-in desk would be looking at.</p>
    <div class="banner"><strong>Example only.</strong> The details below are invented and the booking reference is not a real airline record. Your own reservation carries a genuine PNR you can verify with the airline.</div>

    <div class="doc">
      <div class="wm" aria-hidden="true">
        <span>SAMPLE SAMPLE SAMPLE</span><span>SAMPLE SAMPLE SAMPLE</span><span>SAMPLE SAMPLE SAMPLE</span>
        <span>SAMPLE SAMPLE SAMPLE</span><span>SAMPLE SAMPLE SAMPLE</span><span>SAMPLE SAMPLE SAMPLE</span>
        <span>SAMPLE SAMPLE SAMPLE</span><span>SAMPLE SAMPLE SAMPLE</span>
      </div>

      <div class="doc-head">
        <div>
          <p class="doc-title">Your trip to ${esc(d.city)}</p>
          <p class="doc-sub">
            <img src="/img/sample-carrier-logo.svg" alt="${esc(d.carrier)}" width="20" height="20">
            Airline reservation code: ${esc(d.pnr)} (${esc(d.carrier)})
          </p>
        </div>
        <div>
          <div class="pnr-label">Reservation code</div>
          <div class="pnr">${esc(d.pnr)}</div>
        </div>
      </div>

      <div class="status">Booking confirmed</div>

      ${d.slices.map((sl) => `
      <p class="slice-label">${esc(sl.label)}</p>
      ${sl.segments.map(sampleSegment).join("")}`).join("")}

      <div class="rowline"><span>Passenger</span><span>${esc(d.passenger)}</span></div>
      <div class="rowline"><span>Reservation code</span><span>${esc(d.pnr)}</span></div>
      <div class="rowline"><span>Issued</span><span>${esc(d.issued)}</span></div>

      <div class="fine">
        <p>This is a held reservation, not a purchased ticket. A ticket is only issued if and when payment is completed.</p>
        <p>Verification: a real reservation can be checked directly with the airline using its reservation code.</p>
      </div>
    </div>

    <div class="cta">
      <p>This is an example. Get your real reservation in minutes.</p>
      <a class="btn" href="/#search">Get your reservation &rarr;</a>
      <p style="margin-top:14px;"><a href="/sample-reservation/document.pdf">Download this sample as a PDF</a> to see the exact document you receive.</p>
    </div>
    ${seoLinksHtml("/sample-reservation")}

    <footer>
      <a href="/">Peregrin</a> &middot; <a href="/faq">Help &amp; FAQ</a> &middot; <a href="/privacy">Privacy</a> &middot; <a href="mailto:hello@peregrin.travel">hello@peregrin.travel</a>
    </footer>
  </div>
</body>
</html>`);
});

// The sample reservation as an actual PDF, generated by the real document
// renderer from the static SAMPLE specimen. It carries the PEREGRIN specimen
// watermark (opts.specimen) and the SAMPLE booking reference, so it can never be
// mistaken for a genuine reservation, and it never touches Duffel. This is the
// only PDF path that passes specimen:true; every customer document stays clean.
app.get("/sample-reservation/document.pdf", async (req, res) => {
  try {
    const brand = parseBrand({});
    const { PDFDocument } = await getPdfDeps();
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="peregrin-sample-reservation.pdf"');
    doc.pipe(res);
    renderReservationPdf(doc, sampleOrderForPdf(), brand, {}, { specimen: true });
    doc.end();
  } catch (err) {
    console.error(err.body || err);
    res.status(500).type("text/plain").send("Could not generate the sample document.");
  }
});

// ---------- Programmatic SEO landing pages ----------
// One reusable, server-rendered template (fast + crawlable, deliberately NOT the
// SPA view system) driven by a per-country dataset. Every field below is a
// {{ token }} slot from the design legend — the real visa/immigration copy is
// supplied separately and is intentionally NOT written here.
//
// `placeholder: true` entries render with <meta name="robots" content="noindex">
// and are left out of the sitemap, so an unfinished page can never be indexed as
// thin content — the exact 2025–26 core-update risk the design brief calls out.
const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://www.peregrin.travel";

const SEO_COUNTRIES = {
  "example-country": {
    placeholder: true,
    country_slug: "example-country",
    Country: "Example Country",
    lang: "en",
    meta_hook: "{{ meta_hook }}",
    intro_paragraph: "{{ intro_paragraph }}: placeholder text. Real per-country copy is supplied as a separate dataset.",
    updated_date: "{{ updated_date }}",
    read_time: "{{ read_time }}",
    quick_question: "{{ quick_question }}",
    quick_answer: "{{ quick_answer }}",
    from: "{{ from }}",
    to: "{{ to }}",
    depart: "{{ depart }}",
    requirement_body: "{{ requirement_body }}: placeholder. No real entry, visa or immigration guidance is published on this page yet.",
    accepted_proof: "{{ accepted_proof }}",
    who_checks: "{{ who_checks }}",
    hold_window: "{{ hold_window }}",
    faqs: [
      { q: "{{ faq_q1 }}", a: "{{ faq_a1 }}" },
      { q: "{{ faq_q2 }}", a: "{{ faq_a2 }}" },
      { q: "{{ faq_q3 }}", a: "{{ faq_a3 }}" },
      { q: "{{ faq_q4 }}", a: "{{ faq_a4 }}" },
    ],
    related_1: "{{ related_1 }}",
    related_2: "{{ related_2 }}",
  },
};

function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderSeoPage(d) {
  const title = `${d.Country} onward ticket & proof of onward travel | Peregrin`;
  const description =
    `A real, verifiable onward reservation for ${d.Country} in minutes, held with the airline, ` +
    `no ticket required. ${d.meta_hook}`;
  const canonical = `${SITE_ORIGIN}/onward-ticket/${d.country_slug}`;

  // FAQPage JSON-LD from the same four Q&A pairs rendered below, so the markup
  // and the structured data can never drift apart.
  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: d.faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  const facts = [
    ["Accepted proof", d.accepted_proof],
    ["Who checks", d.who_checks],
    ["Typical hold window", d.hold_window],
  ];
  const steps = [
    ["Search your route", "Live airline fares via Duffel."],
    ["Hold a real reservation", "A genuine PNR, held not ticketed."],
    ["Get your document", "Branded PDF, emailed to you."],
  ];

  return `<!DOCTYPE html>
<html lang="${esc(d.lang || "en")}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
${d.placeholder ? '<meta name="robots" content="noindex,nofollow">' : ""}
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#16283a">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
${ANALYTICS_TAG}
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="/og-image.png">
<script type="application/ld+json">${JSON.stringify(faqLd)}</script>
<style>
  :root { --ink:#16283a; --muted:#5c6b7c; --line:#e2e7ec; --bg:#f8f9fb; --accent:#1c6f8c;
    --accent-bg:#e8f2f5; --accent-dark:#124a5e; --gold:#c9922e; --gold-bg:#faf1e0;
    --success:#1f7a5c; --success-bg:#e7f4ee; }
  @font-face { font-family:'Public Sans'; font-style:normal; font-weight:400; font-display:swap;
    src:url('/fonts/publicsans-400-latin.woff2') format('woff2'); }
  @font-face { font-family:'Public Sans'; font-style:normal; font-weight:600; font-display:swap;
    src:url('/fonts/publicsans-600-latin.woff2') format('woff2'); }
  @font-face { font-family:'Public Sans'; font-style:normal; font-weight:700; font-display:swap;
    src:url('/fonts/publicsans-700-latin.woff2') format('woff2'); }
  @font-face { font-family:'Source Serif 4'; font-style:normal; font-weight:700; font-display:swap;
    src:url('/fonts/sourceserif4-700-latin.woff2') format('woff2'); }
  * { box-sizing:border-box; }
  body { margin:0; color:var(--ink); background:radial-gradient(1100px 420px at 50% -140px, var(--accent-bg), transparent 70%), var(--bg);
    font-family:"Public Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:760px; margin:0 auto; padding:0 24px 70px; }
  header { padding:26px 0 18px; display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .brand { display:flex; align-items:center; gap:10px; text-decoration:none; }
  .mark { font-size:17px; font-weight:800; letter-spacing:.05em; text-transform:uppercase; color:var(--ink); }
  .header-link { display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:600; text-decoration:none;
    color:var(--accent-dark); background:var(--accent-bg); border:1px solid #cfe4ea; border-radius:100px; padding:5px 14px; }
  .crumbs { font-size:12px; color:var(--muted); margin:6px 0 18px; }
  .crumbs a { color:var(--muted); text-decoration:none; }
  .eyebrow { font-size:11px; font-weight:700; letter-spacing:.09em; color:var(--accent); text-transform:uppercase; margin:0 0 10px; }
  h1 { font-family:"Source Serif 4",Georgia,serif; font-size:29px; line-height:1.2; margin:0 0 12px; letter-spacing:-.015em; }
  h2 { font-family:"Source Serif 4",Georgia,serif; font-size:20px; margin:34px 0 10px; }
  h3 { font-size:15px; margin:0 0 6px; }
  p { line-height:1.6; }
  .lede { font-size:15px; color:var(--muted); margin:0 0 10px; }
  .meta { font-size:12px; color:var(--muted); margin:0 0 24px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:14px; padding:22px; margin-bottom:18px;
    box-shadow:0 1px 2px rgba(16,32,45,.04); }
  .quick { background:var(--accent-bg); border:1px solid #cfe4ea; border-radius:12px; padding:18px 20px; margin-bottom:22px; }
  .quick-q { font-size:13px; font-weight:700; color:var(--accent-dark); margin:0 0 6px; text-transform:uppercase; letter-spacing:.04em; }
  .quick-a { font-size:14.5px; color:var(--ink); margin:0; line-height:1.6; }
  .tool { background:#fff; border:1px solid var(--line); border-radius:14px; padding:20px 22px; margin-bottom:10px; }
  .tool-h { font-family:"Source Serif 4",Georgia,serif; font-size:17px; font-weight:700; margin:0 0 4px; }
  .tool-row { display:flex; gap:12px; flex-wrap:wrap; margin:12px 0 14px; }
  .tool-f { flex:1; min-width:120px; }
  .tool-f span { display:block; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin-bottom:4px; }
  .tool-f b { display:block; font-size:14px; font-weight:600; border:1px solid var(--line); border-radius:8px; padding:9px 11px; background:var(--bg); }
  .btn { display:inline-block; background:var(--ink); color:#fff; border-radius:8px; padding:12px 22px; font-size:14px; font-weight:700; text-decoration:none; }
  .btn:hover { opacity:.92; }
  .price { font-size:13.5px; font-weight:600; color:var(--accent-dark); text-align:center; margin:0 0 26px; }
  .facts { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-top:14px; }
  .fact { background:#fff; border:1px solid var(--line); border-radius:10px; padding:13px 14px; }
  .fact span { display:block; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin-bottom:4px; }
  .fact b { font-size:13.5px; font-weight:600; }
  .steps { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
  .step { background:#fff; border:1px solid var(--line); border-radius:12px; padding:16px; }
  .step i { display:flex; align-items:center; justify-content:center; width:24px; height:24px; border-radius:50%;
    background:var(--accent-bg); color:var(--accent-dark); font-size:12px; font-weight:700; font-style:normal; margin-bottom:8px; }
  .step b { display:block; font-size:13.5px; margin-bottom:3px; }
  .step p { font-size:12.5px; color:var(--muted); margin:0; }
  .holds { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .hold { background:#fff; border:1px solid var(--line); border-left:3px solid var(--accent); border-radius:10px; padding:15px 16px; }
  .hold b { display:block; font-size:13.5px; margin-bottom:4px; }
  .hold p { font-size:12.5px; color:var(--muted); margin:0; }
  .faq-item { border-bottom:1px solid var(--line); padding:15px 0; }
  .faq-item:last-child { border-bottom:none; }
  .faq-item p { font-size:13.5px; color:var(--muted); margin:0; }
  .related a { display:block; background:#fff; border:1px solid var(--line); border-radius:10px; padding:13px 16px;
    margin-bottom:8px; text-decoration:none; color:var(--accent-dark); font-size:13.5px; font-weight:600; }
  .cta { background:var(--ink); border-radius:14px; padding:26px 22px; text-align:center; margin-top:30px; }
  .cta b { display:block; font-family:"Source Serif 4",Georgia,serif; font-size:19px; color:#fff; margin-bottom:5px; }
  .cta p { font-size:13.5px; color:#c3d0da; margin:0 0 16px; }
  .cta a { display:inline-block; background:#fff; color:var(--ink); border-radius:8px; padding:11px 22px; font-size:14px; font-weight:700; text-decoration:none; }
  .ribbon { display:flex; gap:12px; margin-top:26px; padding:15px 18px; background:var(--gold-bg); border:1px solid #ecd9ad; border-radius:12px; }
  .ribbon b { font-size:13.5px; color:#6d4d12; }
  .ribbon p { font-size:12.5px; color:#7a5a1d; margin:3px 0 0; }
  .ph { margin-top:26px; padding:12px 16px; border:1px dashed #ecd9ad; background:var(--gold-bg); border-radius:10px;
    font-size:12.5px; color:#7a5a1d; }
  .seo-links { max-width:760px; margin:26px auto 0; padding:16px 20px; background:#fff;
    border:1px solid var(--line); border-radius:12px; text-align:left; }
  .seo-links-h { margin:0 0 8px; font-size:11px; font-weight:700; letter-spacing:.08em;
    text-transform:uppercase; color:var(--accent); }
  .seo-links a { display:block; font-size:13.5px; font-weight:600; color:var(--ink);
    text-decoration:none; padding:7px 0; border-top:1px solid var(--line); }
  .seo-links a:first-of-type { border-top:none; padding-top:0; }
  .seo-links a:hover { color:var(--accent); }
  footer { border-top:1px solid var(--line); margin-top:34px; padding:20px 0; text-align:center; font-size:12.5px; color:var(--muted); }
  footer a { color:var(--accent); text-decoration:none; }
  @media (max-width:620px){ .facts,.steps,.holds{grid-template-columns:1fr;} h1{font-size:24px;} }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <a class="brand" href="/">
        <svg width="26" height="26" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <path d="M5 28C11 26 16 20 19 8" stroke="var(--accent)" stroke-width="4" stroke-linecap="round"/>
          <path d="M12 31C18 28 23 22 26 11" stroke="var(--accent)" stroke-width="4" stroke-linecap="round" opacity="0.55"/>
          <path d="M19 34C25 31 29 25 32 15" stroke="var(--gold)" stroke-width="4" stroke-linecap="round"/>
        </svg>
        <span class="mark">Peregrin</span>
      </a>
      <a class="header-link" href="/faq">Help &amp; FAQ</a>
    </header>

    <nav class="crumbs"><a href="/">Home</a> › <span>Onward ticket</span> › <span>${esc(d.Country)}</span></nav>

    ${d.placeholder ? `<div class="ph"><strong>Placeholder page.</strong> This is the programmatic SEO template rendering with unfilled <code>{{ token }}</code> values. It is served <code>noindex</code> and excluded from the sitemap until the real per-country dataset is supplied.</div>` : ""}

    <p class="eyebrow">Proof of onward travel</p>
    <h1>Proof of onward travel for ${esc(d.Country)}</h1>
    <p class="lede">${esc(d.intro_paragraph)}</p>
    <p class="meta">Updated ${esc(d.updated_date)} · reading time ${esc(d.read_time)}</p>

    <div class="quick">
      <p class="quick-q">${esc(d.quick_question)}</p>
      <p class="quick-a">${esc(d.quick_answer)}</p>
    </div>

    <div class="tool">
      <!-- Deliberately not a heading element: the legend fixes the H2 sequence
           (requires, how it works, holds up, FAQ) so the tool card must not
           inject an extra one ahead of it. -->
      <div class="tool-h">Get an onward ticket for ${esc(d.Country)}</div>
      <p style="font-size:13px; color:var(--muted); margin:0;">Real fares, live from the airline, prefilled for a common exit route.</p>
      <div class="tool-row">
        <div class="tool-f"><span>From</span><b>${esc(d.from)}</b></div>
        <div class="tool-f"><span>To</span><b>${esc(d.to)}</b></div>
        <div class="tool-f"><span>Depart</span><b>${esc(d.depart)}</b></div>
      </div>
      <a class="btn" href="/">Search onward flights →</a>
    </div>
    <p class="price">One flat fee: US$14.99 (US$19.99 return). No airfare, no hidden charges.</p>

    <h2>What ${esc(d.Country)} requires</h2>
    <p>${esc(d.requirement_body)}</p>
    <div class="facts">
      ${facts.map(([k, v]) => `<div class="fact"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}
    </div>

    <h2>How it works</h2>
    <div class="steps">
      ${steps.map(([t, s], i) => `<div class="step"><i>${i + 1}</i><b>${esc(t)}</b><p>${esc(s)}</p></div>`).join("")}
    </div>

    <h2>A reservation that holds up</h2>
    <div class="holds">
      <div class="hold"><b>A real reservation, and you can prove it.</b><p>Verify the booking reference against the airline's own record.</p></div>
      <div class="hold"><b>Straight about what it is.</b><p>A real held reservation, not a purchased ticket, stated plainly on the document.</p></div>
    </div>

    <h2>${esc(d.Country)} onward-ticket FAQ</h2>
    ${d.faqs.map((f) => `<div class="faq-item"><h3>${esc(f.q)}</h3><p>${esc(f.a)}</p></div>`).join("")}

    <h2>Keep reading</h2>
    <div class="related">
      <a href="/faq">${esc(d.related_1)} →</a>
      <a href="/faq">${esc(d.related_2)} →</a>
      <a href="/faq">All Help &amp; FAQ answers →</a>
    </div>

    <div class="cta">
      <b>Get your onward ticket for ${esc(d.Country)}</b>
      <p>Real, verifiable, in about a minute, for one flat fee.</p>
      <a href="/">Reserve a flight →</a>
    </div>

    <div class="ribbon">
      <div>
        <b>A held reservation, not a purchased ticket.</b>
        <p>It lapses automatically if not confirmed, and we say so plainly, because that honesty is exactly what makes it hold up.</p>
      </div>
    </div>

    <footer>
      Real reservations · Independently verifiable · Delivered in minutes · Secured by Stripe<br>
      <a href="/">Peregrin</a> · <a href="/faq">Help &amp; FAQ</a> · <a href="mailto:hello@peregrin.travel">hello@peregrin.travel</a>
    </footer>
  </div>
</body>
</html>`;
}

app.get("/onward-ticket/:country", (req, res) => {
  const data = SEO_COUNTRIES[String(req.params.country).toLowerCase()];
  if (!data) return res.status(404).type("text/plain").send("Not found");
  res.type("html").send(renderSeoPage(data));
});

// Sitemap is generated so published SEO pages are wired in automatically —
// placeholder entries are deliberately excluded (they're also noindex).
// The one list every sitemap consumer shares: /sitemap.xml renders it as XML
// and /seo-status.json reports its size, so the two can never disagree.
function sitemapUrls() {
  const articles = listArticles();
  const esArticles = listArticles("es");
  return [
    { loc: `${SITE_ORIGIN}/`, priority: "1.0", changefreq: "weekly" },
    // Language versions of the homepage. Only these have real translations;
    // the guides are English-only, so they get no language alternates.
    ...Object.entries(LANG_PATHS)
      .filter(([l]) => l !== "en")
      .map(([, p]) => ({ loc: `${SITE_ORIGIN}${p}`, priority: "0.9", changefreq: "weekly" })),
    { loc: `${SITE_ORIGIN}/faq`, priority: "0.7", changefreq: "monthly" },
    // Indexable: it targets "sample flight reservation for visa" (SEO_TARGET_MAP).
    { loc: `${SITE_ORIGIN}/sample-reservation`, priority: "0.6", changefreq: "monthly" },
    { loc: `${SITE_ORIGIN}${VISA_HUB_ROUTE}`, priority: "0.8", changefreq: "weekly" },
    // The blog is the traffic engine, so it and every article are listed.
    // Article lastmod comes from the front-matter date, not today.
    ...(articles.length ? [{ loc: `${SITE_ORIGIN}/blog`, priority: "0.9", changefreq: "weekly" }] : []),
    ...articles.map((a) => ({
      loc: `${SITE_ORIGIN}/blog/${a.slug}`,
      priority: "0.8",
      changefreq: "monthly",
      lastmod: a.date || undefined,
    })),
    // Spanish guide section.
    ...(esArticles.length ? [{ loc: `${SITE_ORIGIN}/es/blog`, priority: "0.9", changefreq: "weekly" }] : []),
    ...esArticles.map((a) => ({
      loc: `${SITE_ORIGIN}/es/blog/${a.slug}`,
      priority: "0.8",
      changefreq: "monthly",
      lastmod: a.date || undefined,
    })),
    ...(readPrivacyPolicy() ? [{ loc: `${SITE_ORIGIN}/privacy`, priority: "0.3", changefreq: "yearly" }] : []),
    ...Object.values(SEO_COUNTRIES)
      .filter((c) => !c.placeholder)
      .map((c) => ({ loc: `${SITE_ORIGIN}/onward-ticket/${c.country_slug}`, priority: "0.8", changefreq: "monthly" })),
  ];
}

app.get("/sitemap.xml", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const urls = sitemapUrls();
  res.type("application/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls
        // Articles carry their own publication date; everything else falls back
        // to today. Claiming every URL changed today is a bad crawl signal.
        .map((u) => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod || today}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`)
        .join("\n") +
      `\n</urlset>\n`
  );
});

// Machine-readable SEO health, for external monitors that shouldn't have to
// crawl. Built from the same sources the pages themselves use (sitemapUrls,
// listArticles, robots.txt on disk), so it cannot drift from what is served.
// no-store: a monitor must always see the current deploy, never an edge copy.
app.get("/seo-status.json", (req, res) => {
  let robots = "";
  try { robots = fs.readFileSync(path.join(__dirname, "public", "robots.txt"), "utf8"); } catch { /* absent = crawlable */ }
  const en = listArticles("en");
  const comparisons = ["best-onward-ticket-services-2026", "peregrin-vs-onwardticket"];
  res.setHeader("Cache-Control", "no-store");
  res.json({
    generated_at: new Date().toISOString(),
    sitemap_url_count: sitemapUrls().length,
    published_en_guides: en.length,
    published_es_guides: listArticles("es").length,
    comparison_pages: comparisons.filter((slug) => en.some((a) => a.slug === slug)).length,
    visa_hub_live: true,
    robots_allows_crawl: !/^\s*Disallow:\s*\/\s*$/m.test(robots),
    sitemap_referenced_in_robots: /^Sitemap:\s*\S+sitemap\.xml/m.test(robots),
    last_deploy: process.env.VERCEL_GIT_COMMIT_SHA || null,
  });
});

// Renders a page's mapped internal links, already filtered to pages that exist.
// Shared by the homepage and the other server-rendered pages so the
// self-activating rule lives in exactly one place.
function seoLinksHtml(route, { heading = "Read next" } = {}) {
  const articles = listArticles();
  const links = liveLinks(route, articles.map((a) => a.slug));
  if (!links.length) return "";
  return `<nav class="seo-links" aria-label="${esc(heading)}">
        <p class="seo-links-h">${esc(heading)}</p>
        ${links.map((l) => `<a href="${esc(l)}">${esc(linkLabel(l, articles))}</a>`).join("")}
      </nav>`;
}

// The homepage is static, but it still needs the analytics tag when analytics is
// on, so it is served through a thin route ahead of express.static. Cached and
// invalidated on mtime, so this stays one read per edit rather than per request.
const INDEX_PATH = path.join(__dirname, "public", "index.html");
// Cache per language, keyed on the file's mtime and the set of published guides:
// publishing a guide changes the injected links even though index.html has not
// been touched.
const indexCache = new Map();
function indexHtml(lang) {
  const { mtimeMs } = fs.statSync(INDEX_PATH);
  const guideKey = listArticles().map((a) => a.slug).join(",");
  const key = `${lang}:${mtimeMs}:${guideKey}`;
  if (!indexCache.has(key)) {
    indexCache.clear(); // only ever one generation of pages is useful
    let html = renderIndexForLang(lang, {
      origin: SITE_ORIGIN,
      headExtra: ANALYTICS_TAG,
      homeLinks: seoLinksHtml("/", { heading: "Popular guides" }),
    });
    // Data-driven country routing for the embassy cards and flag chips: any
    // anchor carrying data-country upgrades to its country guide the moment
    // that guide is published; until then the curated href stays. Derived from
    // disk on every cache rebuild, so publishing a guide rewires the homepage
    // with no code change.
    const routes = countryRouteMap(listArticles("en"));
    html = html.replace(/(data-country="([a-z-]+)"[^>]*href=")([^"]*)(")/g, (m, pre, country, cur, post) =>
      routes[country] ? `${pre}${routes[country]}${post}` : m);
    indexCache.set(key, html);
  }
  return indexCache.get(key);
}

app.get("/", (req, res) => res.type("html").send(indexHtml("en")));

// Real crawlable URLs for the languages that genuinely have translations. The
// HTML arrives already translated rather than relying on a crawler running our
// JavaScript, which is why the translated copy could not rank before.
for (const [lang, urlPath] of Object.entries(LANG_PATHS)) {
  if (lang === "en") continue;
  app.get(urlPath, (req, res) => res.type("html").send(indexHtml(lang)));
}

app.use(express.static(path.join(__dirname, "public")));
// Article imagery lives beside the markdown in content/blog/images so a post and
// its picture stay together. Mounted read-only at the same path the front-matter
// uses; nothing else under content/ is exposed.
app.use(
  BLOG_IMAGE_URL_BASE,
  express.static(path.join(__dirname, "content", "blog", "images"), {
    maxAge: "30d",
    immutable: false,
    index: false,
    dotfiles: "ignore",
    extensions: false,
  })
);

async function duffel(pathname, options = {}) {
  const res = await fetch(`${DUFFEL_BASE}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${DUFFEL_API_KEY}`,
      "Duffel-Version": "v2",
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });
  // Duffel usually returns JSON, but some rejections (e.g. a product like Stays
  // not being enabled for the account) come back as plain text — parse defensively
  // so those don't get swallowed as a generic 500.
  const raw = await res.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { message: raw };
  }
  if (!res.ok) {
    const err = new Error("Duffel API error");
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ---------- Hold-fee entitlement ----------
// Which orders have had their hold fee paid, so the document can be released.
// This in-process cache is only a fast path: on Vercel each invocation can be a
// fresh instance, so it is NOT durable. The authoritative check is asking Stripe
// directly about the Checkout Session the customer came back with, which is
// stateless and works regardless of which instance serves the request.
// A real deployment should persist this in a datastore — see NOTES-FOR-LIAM.md.
// Process-local CACHE of orders whose hold fee is paid. Deliberately not the
// source of truth: see hasDocumentAccess, which falls through to Stripe.
const paidHoldOrders = new Set();

function markHoldFeePaid(orderId) {
  paidHoldOrders.add(orderId);
}

// An order's document is released when EITHER the hold fee has been paid, OR the
// order is already ticketed (the customer paid the full fare via the
// confirm-to-fly path, which obviously also entitles them to the document).
async function hasDocumentAccess(orderId, sessionId, order) {
  // 1. Process-local cache. Fast, but it does NOT survive a restart or a cold
  //    start, and on Vercel the webhook that recorded the payment usually ran in
  //    a different instance from the one serving this request. It is a cache
  //    only; never the source of truth.
  if (paidHoldOrders.has(orderId)) return true;

  // 2. Already ticketed: the fare was paid, so the document is obviously theirs.
  if (order && order.awaiting_payment === false) return true;
  if (!stripeConfigured) return false;
  const stripe = await getStripe();

  // 3. The session the customer was just redirected back with. Covers the
  //    moment right after payment, before Stripe's search index catches up.
  if (sessionId) {
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (
        session.payment_status === "paid" &&
        session.metadata?.order_id === orderId &&
        session.metadata?.purpose === "hold_fee"
      ) {
        markHoldFeePaid(orderId);
        return true;
      }
    } catch (err) {
      console.warn(`Could not verify Stripe session ${sessionId}:`, err.message);
    }
  }

  // 4. Durable entitlement. Stripe already stores every payment we have ever
  //    taken, so it is the store: no database to provision, nothing to keep in
  //    sync, and it survives restarts, redeploys and cold starts. A customer who
  //    paid last week and comes back with no session_id still gets their
  //    document. Search lags new payments by up to a minute, which is exactly
  //    the window step 3 covers.
  return await hasPaidHoldFeeOnRecord(orderId);
}

// Looks the payment up in Stripe by order id. Returns false on any error: a
// Stripe outage must not hand out documents, and must not throw either.
async function hasPaidHoldFeeOnRecord(orderId) {
  if (!stripeConfigured || !/^[A-Za-z0-9_-]{1,80}$/.test(String(orderId || ""))) return false;
  const stripe = await getStripe();
  try {
    const found = await stripe.paymentIntents.search({
      query: `status:'succeeded' AND metadata['order_id']:'${orderId}' AND metadata['purpose']:'hold_fee'`,
      limit: 1,
    });
    if (found.data.length) {
      markHoldFeePaid(orderId);
      return true;
    }
  } catch (err) {
    console.warn(`Durable entitlement lookup failed for ${orderId}:`, err.message);
  }
  return false;
}

// Peregrin's own price list, exposed so the frontend never hardcodes a number.
app.get("/api/pricing", (req, res) => {
  res.json({
    currency: HOLD_FEE_CURRENCY,
    standard: HOLD_FEE_STANDARD,
    multi: HOLD_FEE_MULTI,
    // Boolean only — the key itself must never reach the browser. Drives the
    // dev-only "test-mode data" badge, which stays hidden unless this is true.
    test_mode: DUFFEL_TEST_MODE,
    // The footer only links to /privacy once the policy text actually exists,
    // so we never ship a link that 404s.
    privacy_available: readPrivacyPolicy() !== null,
    // Off in production: the conversion UI stays hidden unless the server says
    // the feature is enabled, matching the routes that 404 while it's off.
    ticket_conversion: ENABLE_TICKET_CONVERSION,
  });
});

// ---------- Places: airport / city type-ahead ----------
// Backed by Duffel's own Places Suggestions dataset, so there's no separate
// airport database to license or keep current. Proxied through the server so
// the Duffel API key never reaches the browser.
app.get("/api/places", async (req, res) => {
  try {
    const query = (req.query.query || "").trim();
    if (query.length < 2) return res.json({ places: [] });
    const result = await duffel(`/places/suggestions?query=${encodeURIComponent(query)}`);
    const places = (result.data || [])
      // Only places that can actually be used as a slice origin/destination.
      .filter((p) => p.iata_code)
      .slice(0, 8)
      .map((p) => ({
        iata_code: p.iata_code,
        name: p.name,
        city_name: p.city_name || p.city?.name || null,
        country_code: p.iata_country_code || null,
        type: p.type || null,
      }));
    res.json({ places });
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// Duffel wants one passenger object per traveller. Ages matter to pricing and
// to what the airline will allow, so the three UI categories map onto Duffel's
// own passenger types rather than being collapsed into a single head count.
//   adult  -> { type: "adult" }              (12+)
//   child  -> { type: "child" }              (2-11)
//   infant -> { type: "infant_without_seat" } (under 2, on an adult's lap)
function buildPassengers({ adults, children, infants, passengers }) {
  // Back-compat: older callers (and the API tests) send a plain adult count.
  if (adults == null && children == null && infants == null) {
    return Array.from({ length: Math.max(1, Number(passengers) || 1) }, () => ({ type: "adult" }));
  }
  const list = [];
  for (let i = 0; i < Number(adults || 0); i++) list.push({ type: "adult" });
  for (let i = 0; i < Number(children || 0); i++) list.push({ type: "child" });
  for (let i = 0; i < Number(infants || 0); i++) list.push({ type: "infant_without_seat" });
  return list.length ? list : [{ type: "adult" }];
}

// ---------- Flights: search ----------
app.post("/api/search", async (req, res) => {
  try {
    const { origin, destination, departure_date, return_date, passengers = 1, adults, children, infants } = req.body;

    const slices = [{ origin, destination, departure_date }];
    if (return_date) {
      slices.push({ origin: destination, destination: origin, departure_date: return_date });
    }

    const payload = {
      data: {
        slices,
        passengers: buildPassengers({ adults, children, infants, passengers }),
        cabin_class: "economy",
      },
    };

    const result = await duffel(`/air/offer_requests?return_offers=true&supplier_timeout=8000`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const offers = (result.data.offers || [])
      // Peregrin only ever holds reservations (never instant-purchase-only fares) —
      // filter out any offer Duffel would reject a "hold" order type for.
      .filter((o) => !o.payment_requirements?.requires_instant_payment)
      .sort((a, b) => parseFloat(a.total_amount) - parseFloat(b.total_amount))
      .slice(0, 6)
      .map((o) => ({
        id: o.id,
        total_amount: o.total_amount,
        total_currency: o.total_currency,
        // When the airline lets the hold sit unpaid until (ISO8601). Surfaced so
        // the results UI can state the validity window as a concrete number
        // instead of a vague promise. Absent on offers where Duffel omits it.
        hold_expires_at: o.payment_requirements?.payment_required_by || null,
        slices: o.slices.map((s) => ({
          origin: s.origin.iata_code,
          destination: s.destination.iata_code,
          segments: s.segments.map((seg) => ({
            departing_at: seg.departing_at,
            arriving_at: seg.arriving_at,
            airline: seg.marketing_carrier.name,
            flight_number: `${seg.marketing_carrier.iata_code}${seg.marketing_carrier_flight_number}`,
            origin: seg.origin.iata_code,
            destination: seg.destination.iata_code,
          })),
        })),
      }));

    res.json({ offer_request_id: result.data.id, offers });
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// ---------- Flights: create a hold order ----------
// The offer was priced for whatever passenger mix the customer searched (see the
// stepper in index.html), so Duffel requires exactly one passenger object per
// offer passenger — one traveller's details each, matched by type. We collect a
// name + date of birth per traveller and reuse the lead's email/phone as contact.
app.post("/api/hold", async (req, res) => {
  try {
    const { offer_id, passengers, passenger, email, phone_number } = req.body;

    // Back-compat: older callers (and the API tests) send a single `passenger`.
    const travellers = Array.isArray(passengers) && passengers.length ? passengers : passenger ? [passenger] : [];
    const contactEmail = email || travellers[0]?.email;
    const contactPhone = phone_number || travellers[0]?.phone_number || "+61400000000";

    // Defence in depth: Duffel requires a name and date of birth per passenger.
    // Blank values were only rejected once the account moved to live keys, and
    // then only as an opaque 422 — so reject them here, before spending a Duffel
    // call, and say exactly which field is missing.
    const missing = [];
    travellers.forEach((t, i) => {
      const label = travellers.length > 1 ? ` (traveller ${i + 1})` : "";
      if (!String(t.given_name || "").trim()) missing.push(`given_name${label}`);
      if (!String(t.family_name || "").trim()) missing.push(`family_name${label}`);
      if (!String(t.born_on || "").trim()) missing.push(`born_on${label}`);
    });
    if (!travellers.length) missing.push("passengers");
    if (!String(contactEmail || "").trim()) missing.push("email");
    if (missing.length) {
      return res.status(400).json({
        error: {
          errors: [{
            type: "validation_error",
            title: "Missing traveller details",
            message: `These required fields are blank: ${missing.join(", ")}.`,
          }],
        },
      });
    }

    const offerResult = await duffel(`/air/offers/${offer_id}?return_available_services=false`);
    const offerPassengers = offerResult.data.passengers || [];

    // Queue up the collected travellers by type so each offer passenger (which
    // carries its own type) gets a matching person; fall back across types if the
    // counts don't line up, so we never send a malformed order.
    const byType = {};
    travellers.forEach((t) => {
      const type = t.type || "adult";
      (byType[type] = byType[type] || []).push(t);
    });
    const anyLeft = () => Object.values(byType).find((q) => q.length);
    const takeFor = (type) => (byType[type] && byType[type].length ? byType[type].shift() : (anyLeft() || []).shift());

    const payloadPassengers = offerPassengers.map((op) => {
      const t = takeFor(op.type) || {};
      return {
        id: op.id,
        title: t.title || "mr",
        given_name: String(t.given_name || "").trim(),
        family_name: String(t.family_name || "").trim(),
        gender: t.gender || "m",
        born_on: String(t.born_on || "").trim(),
        email: contactEmail,
        phone_number: contactPhone,
      };
    });

    const payload = { data: { type: "hold", selected_offers: [offer_id], passengers: payloadPassengers } };

    const result = await duffel(`/air/orders`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    res.json(formatOrder(result.data));
  } catch (err) {
    console.error(err.body || err);
    // Live hold orders are gated per Duffel account. Until Duffel enables them,
    // a live-mode hold fails with 403 insufficient_permissions ("Your team is
    // not allowed to create hold orders in live mode") — captured verbatim from
    // production 2026-07-28. Map it to a stable, friendly error the frontend
    // can recognise, instead of leaking Duffel's account-level wording to a
    // customer. This self-heals: once Duffel flips the switch the 403 stops
    // and holds simply work. No payment can have occurred at this point — the
    // pay buttons only render after a successful hold.
    const duffelErrors = (err.body && err.body.errors) || [];
    const holdGated = duffelErrors.some(
      (e) => e.code === "insufficient_permissions" && /hold orders/i.test(String(e.message || ""))
    );
    if (holdGated) {
      return res.status(503).json({
        error: {
          errors: [{
            type: "hold_unavailable",
            title: "Reservations are briefly paused",
            message: "New reservations reopen shortly. No charge has been made. Please check back soon.",
          }],
        },
      });
    }
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// ---------- Flights: fetch order (used for the "verify this reservation" check) ----------
app.get("/api/order/:id", async (req, res) => {
  try {
    const result = await duffel(`/air/orders/${req.params.id}`);
    res.json(formatOrder(result.data));
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// Pays the airline (via Duffel's account balance) to actually ticket a held order.
// Shared by the manual "Confirm & pay" demo button and the Stripe webhook — in a real
// deployment this is the step that spends Peregrin's own money to fulfil an order a
// customer has already paid Peregrin for.
async function payOrderWithDuffelBalance(orderId) {
  const order = await duffel(`/air/orders/${orderId}`);
  const payload = {
    data: {
      order_id: orderId,
      payment: {
        type: "balance",
        amount: order.data.total_amount,
        currency: order.data.total_currency,
      },
    },
  };
  await duffel(`/air/payments`, { method: "POST", body: JSON.stringify(payload) });
  const updated = await duffel(`/air/orders/${orderId}`);
  return formatOrder(updated.data);
}

// ---------- Flights: confirm & pay (upgrade hold -> real ticketed fare) ----------
// Uses Duffel's test-mode account balance so the demo can show the full
// "confirm before it lapses" flow without needing real card details. This is the
// internal/demo path; /api/order/:id/checkout below is the real customer-facing one.
app.post("/api/order/:id/confirm", async (req, res) => {
  try {
    // DEMO PATH ONLY. This tickets the order out of Peregrin's own Duffel
    // balance with no customer payment — harmless fake money in test mode, but
    // on live keys it would buy a real ticket at Peregrin's expense for anyone
    // who asks. Hiding the button isn't enough; refuse the request outright.
    if (!DUFFEL_TEST_MODE) {
      return res.status(404).json({
        error: { errors: [{ type: "not_found", title: "Not available", message: "This action isn't available." }] },
      });
    }
    res.json(await payOrderWithDuffelBalance(req.params.id));
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// ---------- Payments: the HOLD FEE — Peregrin's actual product ----------
// Charges the customer for the held reservation and its document. This does NOT
// pay the airline and does NOT ticket anything: the hold still lapses on its own
// if the customer never confirms. Deliberately a separate route and a separate
// Stripe `purpose` from /checkout below, which is the "I actually want to fly"
// fare payment — the two must not be conflated.
app.post("/api/order/:id/hold-checkout", async (req, res) => {
  try {
    if (!stripeConfigured) {
      return res.status(501).json({
        error: "Payments aren't configured yet. Set STRIPE_SECRET_KEY to enable this.",
      });
    }
    const stripe = await getStripe();
    const result = await duffel(`/air/orders/${req.params.id}`);
    const order = formatOrder(result.data);
    const brand = parseBrand(req.body);
    const amount = order.hold_fee;
    const origin = `${req.protocol}://${req.get("host")}`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: HOLD_FEE_CURRENCY.toLowerCase(),
            unit_amount: Math.round(amount * 100),
            product_data: {
              name: `${order.hold_fee_label}: ${order.route_summary}`,
              description:
                `${brand.name}: a real, verifiable reservation held with the airline (booking reference ` +
                `${order.booking_reference}), with a PDF you can show at check-in, immigration, or with a visa ` +
                `application. This is a held reservation, not a purchased ticket.`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        order_id: req.params.id,
        purpose: "hold_fee",
        brand_name: brand.name,
        brand_color: brand.accent,
      },
      // The same metadata is copied onto the PaymentIntent because Stripe's
      // Search API can query PaymentIntents by metadata but cannot query
      // Checkout Sessions. This is what makes entitlement durable: see
      // hasDocumentAccess.
      payment_intent_data: {
        metadata: { order_id: req.params.id, purpose: "hold_fee" },
      },
      success_url: `${origin}/?hold_paid_order_id=${req.params.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?hold_checkout_cancelled=1`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// Lets the frontend ask whether a document is unlocked yet (used on return from
// Stripe, and to decide whether to show the pay button or the download buttons).
app.get("/api/order/:id/document-access", async (req, res) => {
  try {
    const result = await duffel(`/air/orders/${req.params.id}`);
    const order = formatOrder(result.data);
    const unlocked = await hasDocumentAccess(req.params.id, req.query.session_id, order);
    res.json({ unlocked, hold_fee: order.hold_fee, hold_fee_currency: order.hold_fee_currency });
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// ---------- Payments: create a Stripe Checkout session for a real customer payment ----------
// This is the path an actual traveller uses to pay Peregrin. Once Stripe confirms the
// payment (via the webhook above), Peregrin pays the airline through Duffel in turn.
app.post("/api/order/:id/checkout", async (req, res) => {
  try {
    if (!stripeConfigured) {
      return res.status(501).json({
        error: "Payments aren't configured yet. Set STRIPE_SECRET_KEY to enable this.",
      });
    }
    const stripe = await getStripe();
    const result = await duffel(`/air/orders/${req.params.id}`);
    const order = formatOrder(result.data);
    const brand = parseBrand(req.body);
    const amount = parseFloat(order.total_amount);
    if (!order.total_amount || Number.isNaN(amount)) {
      return res.status(400).json({ error: "This order has no payable amount." });
    }
    const origin = `${req.protocol}://${req.get("host")}`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: (order.total_currency || "usd").toLowerCase(),
            unit_amount: Math.round(amount * 100),
            product_data: {
              name: `Flight reservation ${order.booking_reference}: ${order.route_summary}`,
              description: `${brand.name}: verifiable flight reservation, booking reference ${order.booking_reference}`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        order_id: req.params.id,
        // Explicit so the webhook can tell this apart from a hold-fee payment.
        purpose: "fare",
        brand_name: brand.name,
        brand_color: brand.accent,
      },
      success_url: `${origin}/?paid_order_id=${req.params.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout_cancelled=1`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// ---------- Ticket conversion: quote, checkout, issuance ----------
// Every route here is behind ENABLE_TICKET_CONVERSION. With the flag off they
// 404, so the flow is unreachable even if the UI is bypassed.
app.use("/api/order/:id/ticket-conversion", (req, res, next) => {
  if (!ENABLE_TICKET_CONVERSION) return res.status(404).json({ error: "Not available." });
  next();
});

// Orders already issued (or mid-issue). The Duffel order state is the durable
// source of truth; this only stops concurrent double-processing inside one
// instance. A real deployment needs this in the datastore alongside the
// hold-fee entitlement — see GO-LIVE-CHECKLIST.md.
const issuingOrders = new Set();

// Live re-price. Never quote from a stale hold: the fare can move between the
// hold and the decision to fly.
async function priceConversion(orderId) {
  const result = await duffel(`/air/orders/${orderId}`);
  const order = formatOrder(result.data);
  const quote = conversionQuote(order.total_amount, order.total_currency);
  return { order, quote };
}

// GET the current breakdown so the UI can show Airfare / Service fee / Total
// BEFORE the customer commits to paying.
app.get("/api/order/:id/ticket-conversion/quote", async (req, res) => {
  try {
    const { order, quote } = await priceConversion(req.params.id);
    if (order.awaiting_payment === false) {
      return res.status(409).json({ error: { errors: [{ type: "already_issued", message: "This reservation already has an e-ticket." }] } });
    }
    res.json({ ...quote, booking_reference: order.booking_reference, route_summary: order.route_summary });
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

app.post("/api/order/:id/ticket-conversion/checkout", async (req, res) => {
  try {
    if (!stripeConfigured) return res.status(501).json({ error: "Payments aren't configured yet." });
    const stripe = await getStripe();
    const orderId = req.params.id;
    const { order, quote } = await priceConversion(orderId);

    if (order.awaiting_payment === false) {
      return res.status(409).json({ error: { errors: [{ type: "already_issued", message: "This reservation already has an e-ticket." }] } });
    }

    // Price integrity: the client tells us what it showed. If the live fare has
    // moved we refuse and hand back the new quote so the customer re-confirms —
    // never silently charge an amount they didn't see.
    const shown = Number(req.body?.expected_total);
    if (Number.isFinite(shown) && Math.abs(shown - quote.total) > 0.009) {
      return res.status(409).json({ error: { errors: [{ type: "price_changed", message: "The fare changed before payment." }] }, quote });
    }

    const brand = parseBrand(req.body);
    const origin = `${req.protocol}://${req.get("host")}`;
    const cur = quote.currency.toLowerCase();

    // Itemised on the Stripe page itself — the fee is never buried.
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: cur,
            unit_amount: Math.round(quote.airfare * 100),
            product_data: {
              name: `Airfare - ${order.route_summary} (${order.booking_reference})`,
              description: `Airline fare for reservation ${order.booking_reference}.`,
            },
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: cur,
            unit_amount: Math.round(quote.service_fee * 100),
            product_data: {
              name: "Service fee",
              description: `${brand.name}: issuing and managing your e-ticket.`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        order_id: orderId,
        purpose: "ticket_conversion",
        airfare: String(quote.airfare),
        service_fee: String(quote.service_fee),
        currency: quote.currency,
      },
      success_url: `${origin}/?ticket_order_id=${orderId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?ticket_checkout_cancelled=1`,
    });

    res.json({ url: session.url, quote });
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// Issue the ticket AFTER a cleared payment. Called only from the webhook.
// If issuance fails the customer is refunded in full — a charged-but-not-issued
// order must never be left sitting silently.
async function issueTicketAfterPayment(orderId, session) {
  if (issuingOrders.has(orderId)) {
    console.log(`Ticket issuance already in progress for ${orderId} - ignoring duplicate webhook.`);
    return;
  }
  issuingOrders.add(orderId);
  try {
    // Durable idempotency: if Duffel already shows it paid, a retry must not
    // pay twice.
    const current = await duffel(`/air/orders/${orderId}`);
    if (formatOrder(current.data).awaiting_payment === false) {
      console.log(`Order ${orderId} is already ticketed - skipping duplicate issuance.`);
      return;
    }
    await payOrderWithDuffelBalance(orderId);
    console.log(`E-ticket issued for order ${orderId} after Stripe payment ${session.id}.`);
  } catch (err) {
    console.error(`ISSUANCE FAILED after payment for order ${orderId}:`, err.body || err);
    // The customer has paid and has no ticket. Refund automatically.
    try {
      const stripe = await getStripe();
      if (stripe && session.payment_intent) {
        await stripe.refunds.create({ payment_intent: session.payment_intent, reason: "requested_by_customer" });
        console.error(`REFUNDED in full for order ${orderId} (Stripe ${session.id}) after issuance failure.`);
      } else {
        console.error(`MANUAL REFUND REQUIRED for order ${orderId} (Stripe ${session.id}) - no payment_intent on session.`);
      }
    } catch (refundErr) {
      // Worst case: paid, not issued, not refunded. Must be loud.
      console.error(`REFUND FAILED for order ${orderId} (Stripe ${session.id}) - MANUAL INTERVENTION REQUIRED:`, refundErr);
    }
  } finally {
    issuingOrders.delete(orderId);
  }
}

// ---------- PDF: the actual document a traveller shows at the border ----------
app.get("/api/order/:id/pdf", async (req, res) => {
  try {
    const result = await duffel(`/air/orders/${req.params.id}`);
    const order = formatOrder(result.data);
    const brand = parseBrand(req.query);

    // The document is the product — release it only once it's been paid for
    // (or the order is already ticketed via the confirm-to-fly path).
    if (!(await hasDocumentAccess(req.params.id, req.query.session_id, order))) {
      return res.status(402).json({
        error: "payment_required",
        message: "This reservation's document hasn't been paid for yet.",
        hold_fee: order.hold_fee,
        hold_fee_currency: order.hold_fee_currency,
      });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${order.booking_reference}-reservation.pdf"`);

    const assets = await preparePdfAssets(order);
    const { PDFDocument } = await getPdfDeps();
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    doc.pipe(res);
    renderReservationPdf(doc, order, brand, assets);
    doc.end();
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// ---------- Email: send the PDF to the traveller ----------
// Sent from Peregrin's own domain — never spoofed to look like it's from an airline.
// Requires RESEND_API_KEY to be set; without it this endpoint explains that clearly
// rather than pretending to have sent anything.
app.post("/api/order/:id/email", async (req, res) => {
  try {
    if (!RESEND_API_KEY) {
      return res.status(501).json({
        error: "Email sending isn't configured yet. Set RESEND_API_KEY to enable this.",
      });
    }
    const result = await duffel(`/air/orders/${req.params.id}`);
    const order = formatOrder(result.data);
    const brand = parseBrand(req.body);

    // Same gate as the PDF download — the emailed document is the same product.
    if (!(await hasDocumentAccess(req.params.id, req.body?.session_id, order))) {
      return res.status(402).json({
        error: "payment_required",
        message: "This reservation's document hasn't been paid for yet.",
        hold_fee: order.hold_fee,
        hold_fee_currency: order.hold_fee_currency,
      });
    }

    const assets = await preparePdfAssets(order);
    const { PDFDocument } = await getPdfDeps();
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    const pdfBuffer = await new Promise((resolve) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      renderReservationPdf(doc, order, brand, assets);
      doc.end();
    });

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: order.passenger_email,
        subject: `Your reservation ${order.booking_reference} with ${brand.name}`,
        html: `<p>Hi ${order.passenger_name},</p>
<p>Your flight reservation is attached as a PDF, and the booking reference below can be verified directly with the airline.</p>
<p><strong>Booking reference:</strong> ${order.booking_reference}<br/>
<strong>Route:</strong> ${order.route_summary}<br/>
<strong>Hold expires:</strong> ${order.payment_required_by || "N/A"}</p>
<p>${brand.name}</p>`,
        attachments: [
          {
            filename: `${order.booking_reference}-reservation.pdf`,
            content: pdfBuffer.toString("base64"),
          },
        ],
      }),
    });

    if (!emailRes.ok) {
      const errBody = await emailRes.json().catch(() => ({}));
      throw Object.assign(new Error("Resend API error"), { status: emailRes.status, body: errBody });
    }

    res.json({ sent: true, to: order.passenger_email });
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// ---------- Stays: accommodation proof-of-booking ----------
// Note: Duffel Stays is a separate product from Duffel Flights and requires its own
// access request (https://duffel.com/contact-us) even after Flights is live.
//
// DISABLED: Stays access isn't approved, so the whole product is switched off
// rather than left reachable. This gate pairs with ENABLE_ACCOMMODATION in
// public/index.html (which hides the UI) — flip both to re-enable. Gating here
// too means the endpoints aren't reachable even if the UI is bypassed.
const ENABLE_ACCOMMODATION = process.env.ENABLE_ACCOMMODATION === "true";

app.use("/api/stays", (req, res, next) => {
  if (!ENABLE_ACCOMMODATION) return res.status(404).json({ error: "Accommodation booking isn't available." });
  next();
});

app.post("/api/stays/search", async (req, res) => {
  try {
    const { latitude, longitude, radius = 5, check_in_date, check_out_date, guests = 1 } = req.body;
    const payload = {
      data: {
        rooms: 1,
        location: { radius, geographic_coordinates: { latitude, longitude } },
        check_in_date,
        check_out_date,
        guests: Array.from({ length: guests }, () => ({ type: "adult" })),
      },
    };
    const result = await duffel(`/stays/search`, { method: "POST", body: JSON.stringify(payload) });
    const results = (result.data.results || []).slice(0, 8).map((r) => ({
      search_result_id: r.id,
      name: r.accommodation?.name,
      location: r.accommodation?.location?.address?.city_name,
      cheapest_rate: r.cheapest_rate_total_amount,
      currency: r.cheapest_rate_currency,
      free_cancellation: r.cheapest_rate_refundable,
    }));
    res.json({ results });
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message, stays_access_required: err.status === 403 });
  }
});

app.get("/api/stays/rates/:search_result_id", async (req, res) => {
  try {
    const result = await duffel(`/stays/search_results/${req.params.search_result_id}/actions/fetch_all_rates`, {
      method: "POST",
    });
    res.json(result.data);
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message, stays_access_required: err.status === 403 });
  }
});

app.post("/api/stays/quote", async (req, res) => {
  try {
    const { rate_id } = req.body;
    const result = await duffel(`/stays/quotes`, {
      method: "POST",
      body: JSON.stringify({ data: { rate_id } }),
    });
    res.json(result.data);
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message, stays_access_required: err.status === 403 });
  }
});

app.post("/api/stays/book", async (req, res) => {
  try {
    const { quote_id, guest, email, phone_number } = req.body;
    const payload = {
      data: {
        quote_id,
        email,
        phone_number,
        guests: [{ given_name: guest.given_name, family_name: guest.family_name, born_on: guest.born_on }],
      },
    };
    const result = await duffel(`/stays/bookings`, { method: "POST", body: JSON.stringify(payload) });
    res.json(result.data);
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message, stays_access_required: err.status === 403 });
  }
});

// ---------- helpers ----------

// Duffel segment timestamps are ISO 8601 with the *local* UTC offset of that airport
// (e.g. "2026-08-15T20:15:00+07:00"). We want to display the wall-clock time at that
// airport, so we read the date/time digits straight out of the string rather than
// letting `Date` re-interpret them in the server's own timezone.
function formatLocalDateTime(iso) {
  if (!iso) return { date: "", time: "" };
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return { date: "", time: "" };
  const [, y, mo, d, h, mi] = m;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const weekday = days[new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay()];
  return { date: `${weekday}, ${+d} ${months[+mo - 1]} ${y}`, time: `${h}:${mi}` };
}

// For duration math (same-segment or gap-between-segments) the offsets make `Date`
// arithmetic safe even though display formatting above avoids `Date` entirely.
function formatDuration(ms) {
  if (ms == null || ms < 0) return "";
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function buildItinerary(rawSlices) {
  return (rawSlices || []).map((slice) => ({
    origin: slice.origin?.iata_code || "",
    destination: slice.destination?.iata_code || "",
    segments: (slice.segments || []).map((seg, i, arr) => {
      const dep = formatLocalDateTime(seg.departing_at);
      const arv = formatLocalDateTime(seg.arriving_at);
      const durationMs =
        seg.departing_at && seg.arriving_at ? new Date(seg.arriving_at) - new Date(seg.departing_at) : null;
      const next = arr[i + 1];
      let layover = null;
      if (next && seg.arriving_at && next.departing_at) {
        const layoverMs = new Date(next.departing_at) - new Date(seg.arriving_at);
        layover = { airport: seg.destination?.iata_code || "", label: formatDuration(layoverMs) };
      }
      // The document shows the OPERATING carrier: that is the airline whose
      // system actually holds the reservation and the one a check-in desk or
      // consulate would call to verify it. Duffel falls back to the marketing
      // carrier when a flight is not a codeshare.
      const operating = seg.operating_carrier || seg.marketing_carrier || {};
      const marketing = seg.marketing_carrier || {};
      const operatingNumber = seg.operating_carrier_flight_number || seg.marketing_carrier_flight_number || "";
      const isCodeshare = Boolean(
        marketing.iata_code && operating.iata_code && marketing.iata_code !== operating.iata_code
      );
      // Cabin is per passenger on a segment; every passenger on a leg shares the
      // same cabin in the fares we hold, so the first one is representative.
      const cabinRaw = seg.passengers?.[0]?.cabin_class_marketing_name || seg.passengers?.[0]?.cabin_class || "";

      return {
        flight_number: `${operating.iata_code || ""}${operatingNumber}`.trim(),
        airline: operating.name || marketing.name || "",
        airline_iata: operating.iata_code || "",
        airline_logo_url: operating.logo_symbol_url || marketing.logo_symbol_url || "",
        // Only set when the marketing and operating carriers genuinely differ,
        // so the PDF can add an "Operated by" line without ever repeating itself.
        operated_by: isCodeshare ? operating.name || "" : "",
        marketing_flight_number: isCodeshare
          ? `${marketing.iata_code || ""}${seg.marketing_carrier_flight_number || ""}`.trim()
          : "",
        cabin: cabinRaw ? String(cabinRaw).replace(/_/g, " ") : "",
        aircraft: seg.aircraft?.name || "",
        origin_iata: seg.origin?.iata_code || "",
        origin_name: seg.origin?.city_name || seg.origin?.name || "",
        origin_terminal: seg.origin_terminal || "",
        destination_iata: seg.destination?.iata_code || "",
        destination_name: seg.destination?.city_name || seg.destination?.name || "",
        destination_terminal: seg.destination_terminal || "",
        departure_date: dep.date,
        departure_time: dep.time,
        arrival_date: arv.date,
        arrival_time: arv.time,
        duration: formatDuration(durationMs),
        layover_after: layover,
      };
    }),
  }));
}

function formatOrder(data) {
  const slice = data.slices?.[0];
  const seg = slice?.segments?.[0];
  const passenger = data.passengers?.[0];
  // A return/multi-city itinerary is more segments and a second Duffel order fee,
  // so it carries the higher price (docs/BUSINESS_PLAN.md §3).
  const sliceCount = data.slices?.length || 1;
  const isMulti = sliceCount > 1;
  return {
    order_id: data.id,
    hold_fee: holdFeeForSliceCount(sliceCount),
    hold_fee_currency: HOLD_FEE_CURRENCY,
    hold_fee_label: isMulti ? "Return / multi-city reservation hold" : "Reservation hold",
    booking_reference: data.booking_reference,
    payment_status: data.payment_status,
    price_guarantee_expires_at: data.payment_status?.price_guarantee_expires_at,
    payment_required_by: data.payment_status?.payment_required_by,
    awaiting_payment: data.payment_status?.awaiting_payment,
    total_amount: data.total_amount,
    total_currency: data.total_currency,
    route_summary: slice ? `${slice.origin?.iata_code} → ${slice.destination?.iata_code}` : "",
    airline: (seg?.operating_carrier || seg?.marketing_carrier)?.name,
    airline_iata: (seg?.operating_carrier || seg?.marketing_carrier)?.iata_code || "",
    airline_logo_url:
      (seg?.operating_carrier || seg?.marketing_carrier)?.logo_symbol_url || "",
    flight_number: seg ? `${seg.marketing_carrier?.iata_code}${seg.marketing_carrier_flight_number}` : "",
    departing_at: seg?.departing_at,
    // Real creation date from Duffel, used as the document's issue date.
    created_at: data.created_at,
    passenger_name: passenger ? `${passenger.given_name} ${passenger.family_name}` : "",
    passenger_email: passenger?.email,
    // Titles come through as "mr"/"ms"; presented as written by the airline.
    passenger_names: (data.passengers || [])
      .map((p) => {
        const title = p.title ? `${String(p.title).replace(/\.$/, "").toUpperCase()} ` : "";
        return `${title}${p.given_name || ""} ${p.family_name || ""}`.trim();
      })
      .filter(Boolean),
    passenger_count: (data.passengers || []).length,
    slices: data.slices,
    itinerary: buildItinerary(data.slices),
  };
}

// Everything the PDF renderer needs that has to be fetched or computed
// asynchronously: carrier logos, the verification QR, and the verify URL for
// this reference. Every part is optional — the renderer degrades cleanly, and a
// failure here must never stop a customer getting their document.
async function preparePdfAssets(order) {
  const verifyUrl = order.booking_reference
    ? `${SITE_ORIGIN}/verify?ref=${encodeURIComponent(order.booking_reference)}`
    : "";

  const { QRCode, SVGtoPDF } = await getPdfDeps();
  const [logos, qr] = await Promise.all([
    collectAirlineLogos(order).catch(() => ({})),
    verifyUrl
      ? QRCode.toBuffer(verifyUrl, { type: "png", errorCorrectionLevel: "M", margin: 0, width: 240 }).catch(() => null)
      : Promise.resolve(null),
  ]);

  return { logos, qr, verifyUrl, svgToPdf: SVGtoPDF };
}

function parseBrand(query) {
  return {
    name: query?.brand_name || "Peregrin",
    accent: query?.brand_color || "#1c6f8c",
  };
}


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Peregrin demo running on http://localhost:${PORT}`));
