import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";
import Stripe from "stripe";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

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
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

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

// Duffel test keys are prefixed `duffel_test_`, live keys `duffel_live_`. This is
// the single source of truth for the dev-only test-mode badge in the UI — only the
// resulting boolean is ever sent to the browser, never the key.
const DUFFEL_TEST_MODE = String(DUFFEL_API_KEY || "").startsWith("duffel_test_");

if (!DUFFEL_API_KEY) {
  console.warn("WARNING: DUFFEL_API_KEY is not set. Set it in .env before making live calls.");
}
if (!stripe) {
  console.warn("WARNING: STRIPE_SECRET_KEY is not set. /api/order/:id/checkout will return 501 until it is.");
}

// The Stripe webhook needs the *raw* request body to verify its signature, so this
// route (and its own express.raw() body parser) must be registered before the global
// express.json() below — Express matches routes in registration order, so this one
// claims the request first and the JSON parser never touches it.
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    console.warn("Stripe webhook received but STRIPE_WEBHOOK_SECRET is not configured — ignoring.");
    return res.status(501).send("Stripe webhook not configured");
  }

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
      } else {
        try {
          // Customer has genuinely paid Peregrin via Stripe at this point. Peregrin now
          // pays the airline via Duffel's balance to actually ticket the reservation —
          // this mirrors the real production flow (customer -> Peregrin -> airline).
          await payOrderWithDuffelBalance(orderId);
          console.log(`Order ${orderId} ticketed with Duffel after Stripe payment ${session.id}.`);
        } catch (err) {
          // The customer has already been charged at this point, so we don't fail the
          // webhook response — but this needs visibility/retry in a real deployment
          // (e.g. an alert or a queue), not just a log line.
          console.error(`Failed to ticket Duffel order ${orderId} after Stripe payment:`, err.body || err);
        }
      }
    }
  }

  res.json({ received: true });
});

app.use(express.json());

// The Help / FAQ page is a client-rendered route served by the same single-page
// file — the inline script reads location.pathname and shows the FAQ view.
// Registered before the static middleware so /faq resolves to index.html.
app.get("/faq", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

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
    intro_paragraph: "{{ intro_paragraph }} — placeholder text. Real per-country copy is supplied as a separate dataset.",
    updated_date: "{{ updated_date }}",
    read_time: "{{ read_time }}",
    quick_question: "{{ quick_question }}",
    quick_answer: "{{ quick_answer }}",
    from: "{{ from }}",
    to: "{{ to }}",
    depart: "{{ depart }}",
    requirement_body: "{{ requirement_body }} — placeholder. No real entry, visa or immigration guidance is published on this page yet.",
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
  const title = `${d.Country} onward ticket & proof of onward travel — Peregrin`;
  const description =
    `A real, verifiable onward reservation for ${d.Country} in minutes — held with the airline, ` +
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
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
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
      <p style="font-size:13px; color:var(--muted); margin:0;">Real fares, live from the airline — prefilled for a common exit route.</p>
      <div class="tool-row">
        <div class="tool-f"><span>From</span><b>${esc(d.from)}</b></div>
        <div class="tool-f"><span>To</span><b>${esc(d.to)}</b></div>
        <div class="tool-f"><span>Depart</span><b>${esc(d.depart)}</b></div>
      </div>
      <a class="btn" href="/">Search onward flights →</a>
    </div>
    <p class="price">One flat fee — US$14.99 (US$19.99 return). No airfare, no hidden charges.</p>

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
      <div class="hold"><b>Straight about what it is.</b><p>A real held reservation, not a purchased ticket — stated plainly on the document.</p></div>
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
      <p>Real, verifiable, in about a minute — one flat fee.</p>
      <a href="/">Reserve a flight →</a>
    </div>

    <div class="ribbon">
      <div>
        <b>A held reservation, not a purchased ticket.</b>
        <p>It lapses automatically if not confirmed — and we say so plainly, because that honesty is exactly what makes it hold up.</p>
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
app.get("/sitemap.xml", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${SITE_ORIGIN}/`, priority: "1.0", changefreq: "weekly" },
    { loc: `${SITE_ORIGIN}/faq`, priority: "0.7", changefreq: "monthly" },
    ...Object.values(SEO_COUNTRIES)
      .filter((c) => !c.placeholder)
      .map((c) => ({ loc: `${SITE_ORIGIN}/onward-ticket/${c.country_slug}`, priority: "0.8", changefreq: "monthly" })),
  ];
  res.type("application/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls
        .map((u) => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`)
        .join("\n") +
      `\n</urlset>\n`
  );
});

app.use(express.static(path.join(__dirname, "public")));

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
const paidHoldOrders = new Set();

function markHoldFeePaid(orderId) {
  paidHoldOrders.add(orderId);
}

// An order's document is released when EITHER the hold fee has been paid, OR the
// order is already ticketed (the customer paid the full fare via the
// confirm-to-fly path, which obviously also entitles them to the document).
async function hasDocumentAccess(orderId, sessionId, order) {
  if (paidHoldOrders.has(orderId)) return true;
  if (order && order.awaiting_payment === false) return true;
  if (!sessionId || !stripe) return false;
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
        given_name: t.given_name,
        family_name: t.family_name,
        gender: t.gender || "m",
        born_on: t.born_on,
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
    if (!stripe) {
      return res.status(501).json({
        error: "Payments aren't configured yet — set STRIPE_SECRET_KEY to enable this.",
      });
    }
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
              name: `${order.hold_fee_label} — ${order.route_summary}`,
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
    if (!stripe) {
      return res.status(501).json({
        error: "Payments aren't configured yet — set STRIPE_SECRET_KEY to enable this.",
      });
    }
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
              name: `Flight reservation ${order.booking_reference} — ${order.route_summary}`,
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

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    doc.pipe(res);
    renderReservationPdf(doc, order, brand);
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
        error: "Email sending isn't configured yet — set RESEND_API_KEY to enable this.",
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

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    const pdfBuffer = await new Promise((resolve) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      renderReservationPdf(doc, order, brand);
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
        subject: `Your reservation ${order.booking_reference} — ${brand.name}`,
        html: `<p>Hi ${order.passenger_name},</p>
<p>Your flight reservation is attached as a PDF, and the booking reference below can be verified directly with the airline.</p>
<p><strong>Booking reference:</strong> ${order.booking_reference}<br/>
<strong>Route:</strong> ${order.route_summary}<br/>
<strong>Hold expires:</strong> ${order.payment_required_by || "N/A"}</p>
<p>— ${brand.name}</p>`,
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
// access request (https://duffel.com/contact-us) even after Flights is live. Until
// that's approved, these calls will fail — the frontend surfaces that clearly rather
// than faking a result.
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
      return {
        flight_number: `${seg.marketing_carrier?.iata_code || ""}${seg.marketing_carrier_flight_number || ""}`.trim(),
        airline: seg.marketing_carrier?.name || "",
        aircraft: seg.aircraft?.name || "",
        origin_iata: seg.origin?.iata_code || "",
        origin_name: seg.origin?.city_name || seg.origin?.name || "",
        destination_iata: seg.destination?.iata_code || "",
        destination_name: seg.destination?.city_name || seg.destination?.name || "",
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
    airline: seg?.marketing_carrier?.name,
    flight_number: seg ? `${seg.marketing_carrier?.iata_code}${seg.marketing_carrier_flight_number}` : "",
    departing_at: seg?.departing_at,
    passenger_name: passenger ? `${passenger.given_name} ${passenger.family_name}` : "",
    passenger_email: passenger?.email,
    passenger_names: (data.passengers || []).map((p) => `${p.given_name} ${p.family_name}`.trim()).filter(Boolean),
    passenger_count: (data.passengers || []).length,
    slices: data.slices,
    itinerary: buildItinerary(data.slices),
  };
}

function parseBrand(query) {
  return {
    name: query?.brand_name || "Peregrin",
    accent: query?.brand_color || "#1c6f8c",
  };
}

// Small vector wing mark echoing the site's header icon — drawn with paths rather
// than an embedded image so the PDF has no external asset dependency.
function drawWingMark(doc, x, y, accent) {
  doc.save();
  doc.lineWidth(2.2).lineCap("round");
  doc.strokeColor(accent).opacity(1)
    .moveTo(x, y + 11).bezierCurveTo(x + 3, y + 9, x + 6, y + 5, x + 7.5, y).stroke();
  doc.strokeColor(accent).opacity(0.55)
    .moveTo(x + 3, y + 12.5).bezierCurveTo(x + 6.5, y + 10.5, x + 9.5, y + 6, x + 11, y + 1).stroke();
  doc.strokeColor("#c9922e").opacity(1)
    .moveTo(x + 6, y + 14).bezierCurveTo(x + 9.5, y + 12, x + 12.5, y + 7.5, x + 14, y + 2).stroke();
  doc.restore();
}

function drawCheck(doc, cx, cy, color) {
  doc.save();
  doc.lineWidth(1.6).lineCap("round").lineJoin("round").strokeColor(color);
  doc.moveTo(cx - 4, cy).lineTo(cx - 1, cy + 3.2).lineTo(cx + 4.5, cy - 4).stroke();
  doc.restore();
}

const PDF_INK = "#16283a";
const PDF_MUTED = "#5c6b7c";
const PDF_LINE = "#d8dee5";

function renderReservationPdf(doc, order, brand) {
  const left = 50;
  const right = 545;
  const width = right - left;
  const held = order.awaiting_payment !== false;

  // ---- Header: brand mark + title, booking reference top-right ----
  drawWingMark(doc, left, 48, brand.accent);
  doc.fontSize(10.5).fillColor(PDF_INK).font("Helvetica-Bold")
    .text(brand.name.toUpperCase(), left + 22, 50, { characterSpacing: 0.8 });

  doc.font("Helvetica").fontSize(9).fillColor(PDF_MUTED)
    .text("Booking reference", left, 50, { width, align: "right" });
  doc.font("Helvetica-Bold").fontSize(16).fillColor(brand.accent)
    .text(order.booking_reference || "—", left, 62, { width, align: "right" });

  doc.moveDown(2);
  doc.font("Helvetica-Bold").fontSize(21).fillColor(PDF_INK).text("Flight Reservation", left, 90);

  // ---- Status banner ----
  const bannerY = doc.y + 14;
  const bannerH = 46;
  const bannerBg = held ? "#e7f4ee" : "#eaf1fb";
  const bannerBorder = held ? "#c3e2d1" : "#c3d7f2";
  const bannerText = held ? "Reservation held" : "Confirmed & ticketed";
  const bannerSub = held
    ? "A real reservation is on hold with the airline. No ticket has been issued yet."
    : "This reservation has been paid and ticketed with the airline.";
  doc.roundedRect(left, bannerY, width, bannerH, 8).fillAndStroke(bannerBg, bannerBorder);
  drawCheck(doc, left + 22, bannerY + bannerH / 2, held ? "#1f7a5c" : "#2a5fa5");
  doc.fillColor(PDF_INK).font("Helvetica-Bold").fontSize(12.5)
    .text(bannerText, left + 40, bannerY + 9, { width: width - 60 });
  doc.fillColor(PDF_MUTED).font("Helvetica").fontSize(9.5)
    .text(bannerSub, left + 40, bannerY + 25, { width: width - 60 });
  doc.y = bannerY + bannerH + 22;

  // ---- Itinerary ----
  doc.font("Helvetica-Bold").fontSize(10).fillColor(brand.accent)
    .text("ITINERARY", left, doc.y, { characterSpacing: 0.8 });
  doc.moveDown(0.6);

  const itinerary = order.itinerary && order.itinerary.length ? order.itinerary : [];
  const sliceLabel = (i) => (itinerary.length > 1 ? (i === 0 ? "Outbound" : "Return") : null);

  itinerary.forEach((slice, sliceIdx) => {
    const label = sliceLabel(sliceIdx);
    if (label) {
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(PDF_MUTED)
        .text(label.toUpperCase(), left, doc.y, { characterSpacing: 0.6 });
      doc.moveDown(0.4);
    }
    slice.segments.forEach((seg, segIdx) => {
      const boxTop = doc.y;
      const padX = 16;
      const padTop = 14;
      let y = boxTop + padTop;

      // Flight number / airline / aircraft
      doc.font("Helvetica-Bold").fontSize(10.5).fillColor(PDF_INK)
        .text(`${seg.flight_number}  ·  ${seg.airline}`, left + padX, y, { width: width - padX * 2 });
      y = doc.y + 2;
      if (seg.aircraft) {
        doc.font("Helvetica").fontSize(8.5).fillColor(PDF_MUTED)
          .text(seg.aircraft, left + padX, y, { width: width - padX * 2 });
        y = doc.y + 6;
      } else {
        y += 6;
      }

      // Origin / destination two-column block with a connecting line
      const colWidth = (width - padX * 2) * 0.4;
      const rowY = y;
      doc.font("Helvetica-Bold").fontSize(15).fillColor(PDF_INK)
        .text(seg.origin_iata, left + padX, rowY, { width: colWidth });
      const leftAfterIata = doc.y;
      doc.font("Helvetica-Bold").fontSize(15).fillColor(PDF_INK)
        .text(seg.destination_iata, left + width - padX - colWidth, rowY, { width: colWidth, align: "right" });
      const rightAfterIata = doc.y;

      let ly = Math.max(leftAfterIata, rightAfterIata) + 1;
      doc.font("Helvetica").fontSize(9).fillColor(PDF_MUTED)
        .text(seg.origin_name, left + padX, ly, { width: colWidth });
      const leftAfterName = doc.y;
      doc.font("Helvetica").fontSize(9).fillColor(PDF_MUTED)
        .text(seg.destination_name, left + width - padX - colWidth, ly, { width: colWidth, align: "right" });
      const rightAfterName = doc.y;

      ly = Math.max(leftAfterName, rightAfterName) + 3;
      doc.font("Helvetica").fontSize(9).fillColor(PDF_INK)
        .text(`${seg.departure_date}  ${seg.departure_time}`, left + padX, ly, { width: colWidth });
      const leftAfterTime = doc.y;
      doc.font("Helvetica").fontSize(9).fillColor(PDF_INK)
        .text(`${seg.arrival_date}  ${seg.arrival_time}`, left + width - padX - colWidth, ly, {
          width: colWidth,
          align: "right",
        });
      const rightAfterTime = doc.y;

      // Connecting line + duration, vertically centered on the IATA-code row
      const lineY = rowY + 8;
      const lineStartX = left + padX + colWidth + 6;
      const lineEndX = left + width - padX - colWidth - 6;
      if (lineEndX > lineStartX) {
        doc.save().lineWidth(1).dash(2, { space: 2 }).strokeColor(PDF_LINE)
          .moveTo(lineStartX, lineY).lineTo(lineEndX, lineY).stroke().undash().restore();
        // arrowhead
        doc.save().fillColor(PDF_LINE)
          .moveTo(lineEndX, lineY - 3).lineTo(lineEndX + 5, lineY).lineTo(lineEndX, lineY + 3).fill().restore();
        if (seg.duration) {
          doc.font("Helvetica").fontSize(8).fillColor(PDF_MUTED)
            .text(seg.duration, lineStartX, lineY - 14, { width: lineEndX - lineStartX, align: "center" });
        }
      }

      const boxBottom = Math.max(leftAfterTime, rightAfterTime) + padTop;
      doc.roundedRect(left, boxTop, width, boxBottom - boxTop, 8).lineWidth(1).stroke(PDF_LINE);
      doc.y = boxBottom + 8;

      if (seg.layover_after) {
        doc.font("Helvetica-Oblique").fontSize(8.5).fillColor(PDF_MUTED)
          .text(`Layover: ${seg.layover_after.label} in ${seg.layover_after.airport}`, left, doc.y, { width });
        doc.moveDown(0.5);
      }
    });
    doc.moveDown(0.3);
  });

  if (!itinerary.length) {
    doc.font("Helvetica").fontSize(10).fillColor(PDF_MUTED)
      .text(order.route_summary ? order.route_summary.replace("→", "-") : "Route details unavailable.", left, doc.y, {
        width,
      });
    doc.moveDown(1);
  }

  // ---- Passenger ----
  doc.moveDown(0.6);
  const names = order.passenger_names && order.passenger_names.length
    ? order.passenger_names
    : (order.passenger_name ? [order.passenger_name] : []);
  doc.font("Helvetica-Bold").fontSize(10).fillColor(brand.accent)
    .text(names.length > 1 ? "PASSENGERS" : "PASSENGER", left, doc.y, { characterSpacing: 0.8 });
  doc.moveDown(0.4);
  (names.length ? names : ["—"]).forEach((n) => {
    doc.font("Helvetica-Bold").fontSize(11).fillColor(PDF_INK).text(n, left, doc.y);
  });
  if (order.payment_required_by) {
    doc.font("Helvetica").fontSize(9).fillColor(PDF_MUTED)
      .text(`Hold expires ${new Date(order.payment_required_by).toUTCString()}`, left, doc.y + 2);
  }

  // ---- Footer notices ----
  doc.moveDown(1.6);
  doc.save().lineWidth(1).strokeColor(PDF_LINE).moveTo(left, doc.y).lineTo(right, doc.y).stroke().restore();
  doc.moveDown(0.8);

  const footerFont = () => doc.font("Helvetica").fontSize(8.5).fillColor(PDF_MUTED);

  footerFont().text(
    `Verification: This reservation can be independently verified with ${order.airline || "the operating carrier"} ` +
      "using the booking reference above. It reflects a genuine reservation held in the airline's own system. This " +
      "document does not itself constitute a ticket unless the status above shows Confirmed & ticketed.",
    left,
    doc.y,
    { width }
  );
  doc.moveDown(0.6);
  footerFont().text(
    "Travel requirements: Entry requirements, visas, and health documentation vary by destination and can change " +
      "without notice. Please confirm current requirements with the relevant embassy, consulate, or airline before travelling.",
    left,
    doc.y,
    { width }
  );
  doc.moveDown(0.6);
  footerFont().text(
    "All times shown are local to the relevant airport. This itinerary has been prepared to support a visa or " +
      "immigration application and reflects the traveller's intended itinerary at the time of issue.",
    left,
    doc.y,
    { width }
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Peregrin demo running on http://localhost:${PORT}`));
