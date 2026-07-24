// Peregrin blog — the SEO/traffic engine.
//
// Articles are plain markdown in content/blog/*.md with YAML front-matter, so
// publishing a new guide is "drop in a file" with no code change. Rendered
// server-side (fast, crawlable) rather than through the SPA view system.
//
// Kept in its own module so server.js doesn't keep growing, and so the
// front-matter parsing and rendering can be unit-tested directly.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { marked } from "marked";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLOG_DIR = path.join(__dirname, "content", "blog");
const BLOG_IMAGE_DIR = path.join(BLOG_DIR, "images");
// Public URL prefix for article imagery; server.js mounts this directory at the
// same path. Kept here so the two cannot drift apart silently.
export const BLOG_IMAGE_URL_BASE = "/content/blog/images";

// Partners whose links carry our tracking. Presence of one of these in a post
// is what triggers the disclosure, so adding a new partner means adding it here
// too. See MONETIZATION_PLAN.md for the strategy.
const AFFILIATE_HOSTS = ["safetywing.com", "booking.com", "airalo.com"];

// Placeholder tracking URLs. "#" means "no real link yet" and the recommended
// box refuses to render a dead link, so nothing can ship pointing nowhere.
// Replace with real tracking URLs as Liam supplies them.
export const AFFILIATE_URLS = {
  AFFILIATE_URL_SAFETYWING:
    "https://safetywing.com/nomad-insurance?referenceID=26568658&campaign=blog&utm_campaign=blog&utm_source=26568658&utm_medium=Ambassador",
  AFFILIATE_URL_BOOKING: "#",
  AFFILIATE_URL_AIRALO: "#",
};

// ---------------------------------------------------------------------------
// AFFILIATE LINK SLOTS — this is the only place to edit when a programme is
// approved. Paste the tracking URL over the "#" and every guide that uses the
// token picks it up. No other file changes.
//
// Articles reference these by name, e.g. [Airalo](AIRALO_LINK), so the markdown
// never has to be touched again either. A slot still set to "#" renders as
// plain text rather than a dead link, which means an unapproved programme can
// never ship a link that goes nowhere.
// ---------------------------------------------------------------------------
export const AFFILIATE_SLOTS = {
  SAFETYWING_LINK: AFFILIATE_URLS.AFFILIATE_URL_SAFETYWING, // live
  BOOKING_LINK: "#",      // pending CJ approval
  AIRALO_LINK: "#",       // eSIM, pending
  AGODA_LINK: "#",        // hotels, alternative to Booking, pending
  GETYOURGUIDE_LINK: "#", // experiences, pending
};

// True when a slot has a real URL behind it.
export function affiliateSlotLive(name) {
  const v = AFFILIATE_SLOTS[name];
  return Boolean(v && v !== "#");
}

export const AFFILIATE_DISCLOSURE =
  "Some links in this post are affiliate links. If you book through them we may earn a small " +
  "commission, at no extra cost to you.";

// Raw HTML in an article is dropped rather than passed through. The content is
// ours, but this keeps a stray tag (or anything pasted in from elsewhere) from
// ever reaching the page, without pulling in a DOM-based sanitiser.
marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    html() { return ""; },
    // Inline images render as lazy, responsive figures. Markdown's title slot
    // doubles as the caption, so `![alt](src "caption")` prints one.
    image({ href, title, text }) {
      if (!href) return "";
      const cap = title ? `<figcaption>${esc(title)}</figcaption>` : "";
      return `<figure class="body-figure">` +
        `<img src="${esc(href)}" alt="${esc(text || "")}" loading="lazy" decoding="async">` +
        `${cap}</figure>`;
    },
    // Outbound citations (embassy and government sources) open in a new tab.
    // noopener/noreferrer is required: without it the opened page gets a handle
    // on ours via window.opener.
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!href) return label;

      // An article may use a slot name in place of a URL. Unfilled slots, and a
      // bare "#", degrade to plain text: a partner we have not been approved by
      // must never get a live-looking link that goes nowhere.
      const isSlot = Object.prototype.hasOwnProperty.call(AFFILIATE_SLOTS, href);
      const resolved = isSlot ? AFFILIATE_SLOTS[href] : href;
      if (!resolved || resolved === "#") return label;

      const affiliate = isSlot || AFFILIATE_HOSTS.some((h) => resolved.includes(h));
      const external = /^https?:\/\//i.test(resolved) && !/(^https?:\/\/)([^/]*\.)?peregrin\.travel/i.test(resolved);
      const t = title ? ` title="${esc(title)}"` : "";
      // Affiliate links must declare themselves to search engines.
      const relBits = external ? ["noopener", "noreferrer"] : [];
      if (affiliate) relBits.push("sponsored");
      const rel = relBits.length ? ` target="_blank" rel="${relBits.join(" ")}"` : "";
      return `<a href="${esc(resolved)}"${t}${rel}>${label}</a>`;
    },
  },
});

export function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Minimal YAML front-matter reader: flat `key: value` pairs with optional
// quotes, which is all the article format uses.
function parseFrontMatter(raw) {
  const m = raw.match(/^﻿?---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    data[kv[1]] = v;
  }
  return { data, body: m[2] };
}

// The body opens with its own H1. We lift it out and render it as the article
// header instead, so the page has exactly one <h1> rather than two competing
// headlines (front-matter title is the SEO/<title> string, which is longer).
function splitLeadHeading(body) {
  const m = body.match(/^\s*#\s+(.+?)\s*\r?\n/);
  if (!m) return { heading: null, rest: body };
  return { heading: m[1].trim(), rest: body.slice(m[0].length) };
}

function readArticleFile(file) {
  const raw = fs.readFileSync(path.join(BLOG_DIR, file), "utf8");
  const { data, body } = parseFrontMatter(raw);
  const slug = data.slug || file.replace(/\.md$/, "");
  const { heading, rest } = splitLeadHeading(body);
  return {
    slug,
    title: data.title || heading || slug,
    heading: heading || data.title || slug,
    description: data.description || "",
    keyword: data.keyword || "",
    date: data.date || "",
    lang: data.lang || "en",
    readingTime: data.readingTime || "",
    // Destination chip: the last comma-free chunk of the slug reads oddly, so
    // derive it from the keyword where possible.
    destination: deriveDestination(data.keyword, data.title),
    // A hero is only reported when the file really exists, so a post whose
    // image has not been added yet renders cleanly instead of showing a broken
    // image. Alt text is required alongside it: a decorative-looking hero with
    // no alt is worse than none for a screen reader.
    hero: heroIfPresent(data.hero),
    heroAlt: data.heroAlt || "",
    body: rest,
    // Affiliate disclosure is driven by what the post actually links to rather
    // than a flag someone has to remember to set.
    hasAffiliate: hasAffiliateLink(rest) || Boolean(data.recommendPartner),
    // Guides carry the lighter disclosure inline, right above the links it
    // covers, which reads better than a banner at the top of the article. The
    // banner is therefore only rendered when the body has no inline one, so a
    // reader always sees exactly one disclosure and never two.
    hasInlineDisclosure: /affiliate link/i.test(rest),
    // Optional partner placement, supplied per post in front-matter.
    recommend: data.recommendPartner
      ? {
          partner: data.recommendPartner,
          title: data.recommendTitle || "",
          body: data.recommendBody || "",
          cta: data.recommendCta || "",
        }
      : null,
  };
}

// Maps a public hero path (/content/blog/images/x.jpg) to disk and confirms it
// exists. Anything outside the images folder is refused outright.
function heroIfPresent(hero) {
  const val = String(hero || "").trim();
  if (!val.startsWith(BLOG_IMAGE_URL_BASE + "/")) return "";
  const name = val.slice(BLOG_IMAGE_URL_BASE.length + 1);
  if (!/^[\w.-]+$/.test(name) || name.includes("..")) return "";
  return fs.existsSync(path.join(BLOG_IMAGE_DIR, name)) ? val : "";
}

function hasAffiliateLink(body) {
  return AFFILIATE_HOSTS.some((h) => body.includes(h)) ||
    Object.keys(AFFILIATE_SLOTS).some((slot) => body.includes(`(${slot})`)) ||
    body.includes("<!-- AFFILIATE:");
}

function deriveDestination(keyword, title) {
  const src = String(keyword || title || "");
  const m = src.match(/proof of onward travel\s+(.*)$/i);
  const raw = (m ? m[1] : "").trim();
  if (!raw) return "";
  // "Bali Indonesia" -> "Bali"; keep it short enough for a chip.
  return raw.split(/[\s,]+/).slice(0, 1).join(" ");
}

export function listArticles() {
  let files = [];
  try {
    files = fs.readdirSync(BLOG_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  return files
    .map(readArticleFile)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export function getArticle(slug) {
  return listArticles().find((a) => a.slug === slug) || null;
}

export function renderArticleBody(md) {
  return marked.parse(md);
}

function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return "";
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

// ---------------------------------------------------------------- chrome ----

const FONTS = `
  @font-face { font-family:'Public Sans'; font-style:normal; font-weight:400; font-display:swap;
    src:url('/fonts/publicsans-400-latin.woff2') format('woff2'); }
  @font-face { font-family:'Public Sans'; font-style:normal; font-weight:600; font-display:swap;
    src:url('/fonts/publicsans-600-latin.woff2') format('woff2'); }
  @font-face { font-family:'Public Sans'; font-style:normal; font-weight:700; font-display:swap;
    src:url('/fonts/publicsans-700-latin.woff2') format('woff2'); }
  @font-face { font-family:'Source Serif 4'; font-style:normal; font-weight:600; font-display:swap;
    src:url('/fonts/sourceserif4-600-latin.woff2') format('woff2'); }
  @font-face { font-family:'Source Serif 4'; font-style:normal; font-weight:700; font-display:swap;
    src:url('/fonts/sourceserif4-700-latin.woff2') format('woff2'); }`;

const TOKENS = `
  :root { --ink:#16283a; --muted:#5c6b7c; --line:#e2e7ec; --bg:#f8f9fb; --accent:#1c6f8c;
    --accent-bg:#e8f2f5; --accent-dark:#124a5e; --gold:#c9922e; --gold-bg:#faf1e0;
    --success:#1f7a5c; --success-bg:#e7f4ee; }`;

const BASE_CSS = `
  * { box-sizing:border-box; }
  body { margin:0; color:var(--ink);
    background:radial-gradient(1100px 420px at 50% -140px, var(--accent-bg), transparent 70%), var(--bg);
    font-family:"Public Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased; }
  .wrap { max-width:760px; margin:0 auto; padding:0 24px 72px; }
  header.site { padding:26px 0 18px; display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .brand { display:flex; align-items:center; gap:10px; text-decoration:none; }
  .mark { font-size:17px; font-weight:800; letter-spacing:.05em; text-transform:uppercase; color:var(--ink); }
  .header-link { display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:600;
    text-decoration:none; color:var(--accent-dark); background:var(--accent-bg); border:1px solid #cfe4ea;
    border-radius:100px; padding:5px 14px; }
  .crumbs { font-size:12px; color:var(--muted); margin:4px 0 20px; }
  .crumbs a { color:var(--muted); text-decoration:none; }
  .crumbs a:hover { color:var(--accent); }
  .eyebrow { font-size:11px; font-weight:700; letter-spacing:.09em; color:var(--accent);
    text-transform:uppercase; margin:0 0 10px; }
  footer.site { border-top:1px solid var(--line); margin-top:44px; padding:22px 0; text-align:center;
    font-size:12.5px; color:var(--muted); }
  footer.site a { color:var(--accent); text-decoration:none; }
  .foot-disclaimer { max-width:68ch; margin:14px auto 0; font-size:11.5px; line-height:1.6; color:var(--muted); text-align:left; }`;

function shell({ title, description, canonical, lang, jsonLd, css, body, ogType = "website" }) {
  const ld = (jsonLd || []).map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join("\n");
  return `<!DOCTYPE html>
<html lang="${esc(lang || "en")}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="${esc(ogType)}">
<meta property="og:site_name" content="Peregrin">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="/og-image.png">
${ld}
<style>${TOKENS}${FONTS}${BASE_CSS}${css || ""}</style>
</head>
<body>
  <div class="wrap">
    <header class="site">
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
${body}
    <footer class="site">
      <a href="/">Peregrin</a> &middot; <a href="/blog">Guides</a> &middot; <a href="/faq">Help &amp; FAQ</a>
      &middot; <a href="/privacy">Privacy Policy</a> &middot; <a href="mailto:hello@peregrin.travel">hello@peregrin.travel</a>
      <p class="foot-disclaimer">Peregrin provides genuine, verifiable flight reservations for legitimate
      proof-of-onward-travel, visa, and immigration documentation. A reservation is a held airline booking
      , not a purchased ticket and not travel; an e-ticket is issued only if you choose to confirm and
      pay the fare.</p>
    </footer>
  </div>
</body>
</html>`;
}

// ----------------------------------------------------------------- index ----

const IMAGE_CSS = `
  .hero-figure { margin: 0 0 26px; border-radius: 14px; overflow: hidden; background: #eef1f4;
    border: 1px solid var(--line); }
  .hero-figure img { display: block; width: 100%; height: auto; aspect-ratio: 2 / 1; object-fit: cover; }
  .body-figure { margin: 26px 0; }
  .body-figure img { display: block; width: 100%; height: auto; border-radius: 12px; border: 1px solid var(--line); }
  .body-figure figcaption { margin-top: 8px; font-size: 12.5px; color: var(--muted); text-align: center; }
`;

const INDEX_CSS = IMAGE_CSS + `
  .card-img { display: block; width: calc(100% + 2px); height: auto; margin: -1px -1px 16px;
    aspect-ratio: 2 / 1; object-fit: cover; border-radius: 13px 13px 0 0; background: #eef1f4; }

  h1.page { font-family:"Source Serif 4",Georgia,serif; font-size:32px; line-height:1.15;
    letter-spacing:-.02em; margin:0 0 10px; }
  .page-lede { font-size:16px; color:var(--muted); line-height:1.6; margin:0 0 34px; max-width:60ch; }
  .cards { display:flex; flex-direction:column; gap:16px; }
  .card-post { display:block; text-decoration:none; color:inherit; background:#fff; border:1px solid var(--line);
    border-radius:14px; padding:24px 26px; box-shadow:0 1px 2px rgba(16,32,45,.04);
    transition:transform .16s ease, box-shadow .16s ease, border-color .16s ease; }
  .card-post:hover { transform:translateY(-2px); box-shadow:0 10px 28px rgba(16,32,45,.10); border-color:#cfe4ea; }
  .card-meta { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:9px; }
  .chip { font-size:11px; font-weight:700; letter-spacing:.03em; color:var(--accent-dark);
    background:var(--accent-bg); border-radius:100px; padding:3px 11px; }
  .card-time { font-size:11.5px; color:var(--muted); }
  .card-title { font-family:"Source Serif 4",Georgia,serif; font-size:21px; font-weight:700;
    line-height:1.3; margin:0 0 7px; letter-spacing:-.01em; }
  .card-post:hover .card-title { color:var(--accent-dark); }
  .card-excerpt { font-size:14px; color:var(--muted); line-height:1.6; margin:0; }
  @media (max-width:620px){ h1.page{font-size:26px;} .card-post{padding:20px;} }`;

export function renderBlogIndex(articles, origin) {
  const canonical = `${origin}/blog`;
  const cards = articles.map((a) => `
      <a class="card-post" href="/blog/${esc(a.slug)}">
        ${a.hero ? `<img class="card-img" src="${esc(a.hero)}" alt="${esc(a.heroAlt)}" loading="lazy" decoding="async" width="1600" height="800">` : ""}
        <div class="card-meta">
          ${a.destination ? `<span class="chip">${esc(a.destination)}</span>` : ""}
          ${a.readingTime ? `<span class="card-time">${esc(a.readingTime)} read</span>` : ""}
        </div>
        <h2 class="card-title">${esc(a.title)}</h2>
        <p class="card-excerpt">${esc(a.description)}</p>
      </a>`).join("");

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "Blog",
      name: "Peregrin Guides",
      description: "Practical guides to proof of onward travel, visa requirements and flexible travel planning.",
      url: canonical,
    },
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: articles.map((a, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: `${origin}/blog/${a.slug}`,
        name: a.title,
      })),
    },
  ];

  return shell({
    title: "Guides: proof of onward travel & visa requirements | Peregrin",
    description: "Practical, up-to-date guides to proof of onward travel, visa requirements and how to satisfy them without buying a flight you may never take.",
    canonical,
    lang: "en",
    jsonLd,
    css: INDEX_CSS,
    body: `
    <nav class="crumbs"><a href="/">Home</a> &rsaquo; <span>Guides</span></nav>
    <p class="eyebrow">Guides</p>
    <h1 class="page">Proof of onward travel, explained</h1>
    <p class="page-lede">Clear, current guides to what border officials and airlines actually ask for, and the simplest way to satisfy it.</p>
    <div class="cards">${cards}</div>`,
  });
}

// --------------------------------------------------------------- article ----

const SIDEBAR_CSS = `
  /* The inline disclosure sits in the body as an italic aside; give it a little
     more presence than surrounding prose without shouting. */
  .prose p em:only-child { color: var(--muted); font-size: 15px; }

  /* Two columns from 980px up, where there is room for a 260px rail beside a
     comfortable measure. Below that the sidebar stacks under the article rather
     than being hidden: the checklist is the part people want on a phone. */
  .article-layout { display: block; }
  .sidebar { display: flex; flex-direction: column; gap: 14px; margin: 34px 0 0; }
  .side-box { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; }
  .side-h { margin: 0 0 10px; font-size: 11px; font-weight: 700; letter-spacing: .08em;
    text-transform: uppercase; color: var(--accent); }
  .side-list { list-style: none; margin: 0; padding: 0; }
  .side-list li + li { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
  .side-list a { font-size: 13.5px; font-weight: 600; line-height: 1.45; color: var(--ink); text-decoration: none; }
  .side-list a:hover { color: var(--accent); }
  .side-check { background: var(--accent-bg); border-color: #cfe4ea; }
  .side-check-list { list-style: none; margin: 0; padding: 0; }
  .side-check-list li { position: relative; padding-left: 22px; font-size: 13px; line-height: 1.55;
    color: var(--ink); }
  .side-check-list li + li { margin-top: 9px; }
  .side-check-list li::before { content: ""; position: absolute; left: 2px; top: 6px; width: 9px; height: 5px;
    border-left: 2px solid var(--accent); border-bottom: 2px solid var(--accent); transform: rotate(-45deg); }
  .side-note { margin: 12px 0 0; font-size: 11.5px; line-height: 1.5; color: var(--muted); }
  .side-cta-d { margin: 0 0 12px; font-size: 13px; line-height: 1.55; color: var(--muted); }
  .side-cta a { display: inline-block; font-size: 13px; font-weight: 700; color: #fff; background: var(--ink);
    border-radius: 8px; padding: 9px 16px; text-decoration: none; }
  .side-cta a:hover { background: var(--accent-dark); }
  @media (min-width: 980px) {
    .article-layout { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 44px; align-items: start; }
    .sidebar { margin: 0; position: sticky; top: 24px; }
  }
`;

const ARTICLE_CSS = IMAGE_CSS + SIDEBAR_CSS + `
  @media (min-width: 980px) { .wrap { max-width: 1100px; } }

  .affiliate-note { font-size: 12.5px; color: var(--muted); line-height: 1.55; margin: 0 0 24px;
    padding: 10px 14px; background: #f4f6f8; border-radius: 8px; border: 1px solid var(--line); }
  .rec-box { margin: 30px 0 6px; padding: 20px 22px; background: var(--gold-bg); border: 1px solid #ecd9ad;
    border-left: 3px solid var(--gold); border-radius: 12px; }
  .rec-label { margin: 0 0 6px; font-size: 11px; font-weight: 700; letter-spacing: .08em;
    text-transform: uppercase; color: #7a5a1d; }
  .rec-title { margin: 0 0 6px; font-family: "Source Serif 4", Georgia, serif; font-size: 17px;
    font-weight: 700; color: #6d4d12; }
  .rec-body { margin: 0 0 12px; font-size: 14px; line-height: 1.6; color: #6d4d12; }
  .rec-cta { display: inline-block; font-size: 13.5px; font-weight: 700; color: var(--accent-dark);
    text-decoration: none; }
  .rec-cta-pending { color: var(--muted); font-weight: 600; }

  article { max-width:66ch; }
  h1.page { font-family:"Source Serif 4",Georgia,serif; font-size:34px; line-height:1.14;
    letter-spacing:-.02em; margin:0 0 12px; }
  .article-meta { font-size:13px; color:var(--muted); margin:0 0 30px; }
  .prose { font-size:18px; line-height:1.75; color:#243546; }
  .prose > p { margin:0 0 20px; }
  .prose h2 { font-family:"Source Serif 4",Georgia,serif; font-size:25px; line-height:1.25;
    letter-spacing:-.01em; margin:40px 0 12px; }
  .prose h3 { font-size:18px; font-weight:700; margin:28px 0 8px; }
  .prose ul, .prose ol { margin:0 0 20px; padding-left:24px; }
  .prose li { margin-bottom:9px; }
  .prose a { color:var(--accent); text-decoration:underline; text-underline-offset:2px; }
  .prose a:hover { color:var(--accent-dark); }
  .prose strong { font-weight:700; color:var(--ink); }
  .prose em { font-style:italic; }
  .prose hr { border:0; border-top:1px solid var(--line); margin:34px 0; }
  .prose table { width:100%; border-collapse:collapse; margin:0 0 22px; font-size:15.5px; }
  .prose th, .prose td { border:1px solid var(--line); padding:9px 12px; text-align:left; }
  .prose th { background:var(--accent-bg); color:var(--accent-dark); font-weight:700; }
  /* The in-article "this is where Peregrin fits" quote — a considered pull-quote,
     deliberately not a grey code-ish slab. */
  .prose blockquote { margin:28px 0; padding:20px 24px; background:var(--accent-bg);
    border:1px solid #cfe4ea; border-left:3px solid var(--accent); border-radius:12px;
    font-size:17px; line-height:1.65; color:var(--accent-dark); }
  .prose blockquote p { margin:0; }
  .prose blockquote p + p { margin-top:12px; }
  .prose code { font-family:ui-monospace,"SF Mono",monospace; font-size:.9em;
    background:var(--bg); border:1px solid var(--line); border-radius:5px; padding:1px 5px; }
  .cta-card { background:var(--ink); border-radius:14px; padding:30px 28px; text-align:center; margin:44px 0 0; }
  .cta-card h2 { font-family:"Source Serif 4",Georgia,serif; font-size:23px; color:#fff; margin:0 0 8px; }
  .cta-card p { font-size:14.5px; color:#c3d0da; line-height:1.6; margin:0 0 18px; }
  .cta-card a { display:inline-block; background:#fff; color:var(--ink); border-radius:8px;
    padding:12px 26px; font-size:15px; font-weight:700; text-decoration:none; }
  .cta-card a:hover { opacity:.92; }
  .back-link { display:inline-block; margin-top:26px; font-size:13.5px; color:var(--accent);
    text-decoration:none; font-weight:600; }
  .related { margin-top:34px; padding-top:22px; border-top:1px solid var(--line); }
  .related-h { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.05em;
    color:var(--muted); margin:0 0 10px; }
  .related a { display:block; font-size:14.5px; color:var(--accent-dark); text-decoration:none;
    font-weight:600; padding:7px 0; }
  .related a:hover { color:var(--accent); }
  @media (max-width:620px){ h1.page{font-size:26px;} .prose{font-size:17px;} .prose h2{font-size:21px;} }`;

// Reusable "recommended" box for partner placements.
//
// A box whose tracking URL is still the "#" placeholder renders as plain text
// with no link. Shipping a live-looking button that goes nowhere would be worse
// than showing nothing, and it would also earn nothing. Copy for each placement
// comes from the post's own front-matter, so Cowork can add one without a code
// change.
export function renderRecommendedBox(spec) {
  // A post with no placement passes null, which a default parameter would not
  // catch, so normalise before destructuring.
  const { partner, title, body, cta } = spec || {};
  const key = `AFFILIATE_URL_${String(partner || "").toUpperCase()}`;
  if (!Object.prototype.hasOwnProperty.call(AFFILIATE_URLS, key)) return "";
  if (!title || !body) return "";

  const url = AFFILIATE_URLS[key];
  const live = url && url !== "#";
  const action = live
    ? `<a class="rec-cta" href="${esc(url)}" target="_blank" rel="noopener noreferrer sponsored">${esc(cta || "Take a look")} &rarr;</a>`
    : `<span class="rec-cta rec-cta-pending">Link coming soon</span>`;

  return `
      <aside class="rec-box">
        <p class="rec-label">Recommended</p>
        <p class="rec-title">${esc(title)}</p>
        <p class="rec-body">${esc(body)}</p>
        ${action}
      </aside>`;
}

// Right-hand sidebar for a guide: the other guides, plus a short pre-flight
// checklist. On narrow screens it drops below the article rather than being
// hidden, since the checklist is genuinely useful on a phone at the airport.
function renderSidebar(article, allArticles) {
  const others = allArticles.filter((a) => a.slug !== article.slug);
  const popular = others.length
    ? `<nav class="side-box" aria-labelledby="side-guides-h">
        <p class="side-h" id="side-guides-h">Popular guides</p>
        <ul class="side-list">
          ${others.map((a) => `<li><a href="/blog/${esc(a.slug)}">${esc(a.heading || a.title)}</a></li>`).join("")}
        </ul>
      </nav>`
    : "";

  // Deliberately generic: these are the four things that actually stop people at
  // a gate or a border, and none of them claims to be immigration advice.
  const checklist = `
      <aside class="side-box side-check" aria-labelledby="side-check-h">
        <p class="side-h" id="side-check-h">Before you fly</p>
        <ul class="side-check-list">
          <li>Onward or return travel sorted, and verifiable if you are asked for it.</li>
          <li>Travel insurance that covers your whole trip, not just the first month.</li>
          <li>Somewhere booked for the first night, ideally free to cancel.</li>
          <li>Arrival card, e-visa or entry fee done in advance where your destination asks for one.</li>
        </ul>
        <p class="side-note">Requirements change and vary by nationality. Check your airline and destination before you travel.</p>
      </aside>`;

  const cta = `
      <aside class="side-box side-cta">
        <p class="side-h">Need proof of onward travel?</p>
        <p class="side-cta-d">A real, verifiable airline reservation in minutes. No airfare paid unless you choose to fly.</p>
        <a href="/">Get a reservation &rarr;</a>
      </aside>`;

  return `<div class="sidebar">${popular}${checklist}${cta}</div>`;
}

export function renderArticle(article, allArticles, origin) {
  const canonical = `${origin}/blog/${article.slug}`;
  const related = allArticles.filter((a) => a.slug !== article.slug).slice(0, 3);

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: article.title,
      description: article.description,
      datePublished: article.date,
      dateModified: article.date,
      inLanguage: article.lang,
      mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
      author: { "@type": "Organization", name: "Peregrin", url: origin },
      publisher: {
        "@type": "Organization",
        name: "Peregrin",
        url: origin,
        logo: { "@type": "ImageObject", url: `${origin}/og-image.png` },
      },
      image: `${origin}/og-image.png`,
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: `${origin}/` },
        { "@type": "ListItem", position: 2, name: "Guides", item: `${origin}/blog` },
        { "@type": "ListItem", position: 3, name: article.heading, item: canonical },
      ],
    },
  ];

  const metaBits = [formatDate(article.date), article.readingTime ? `${article.readingTime} read` : ""]
    .filter(Boolean).join(" &middot; ");

  return shell({
    title: article.title,
    description: article.description,
    canonical,
    lang: article.lang,
    jsonLd,
    css: ARTICLE_CSS,
    ogType: "article",
    body: `
    <nav class="crumbs"><a href="/">Home</a> &rsaquo; <a href="/blog">Guides</a> &rsaquo; <span>${esc(article.destination || "Guide")}</span></nav>
    <div class="article-layout">
    <article>
      <h1 class="page">${esc(article.heading)}</h1>
      <p class="article-meta">${metaBits}</p>
      ${article.hero ? `<figure class="hero-figure">
        <img src="${esc(article.hero)}" alt="${esc(article.heroAlt)}" width="1600" height="800" decoding="async" fetchpriority="high">
      </figure>` : ""}
      ${article.hasAffiliate && !article.hasInlineDisclosure ? `<p class="affiliate-note">${esc(AFFILIATE_DISCLOSURE)}</p>` : ""}
      <div class="prose">${renderArticleBody(article.body)}</div>
      ${renderRecommendedBox(article.recommend)}

      <div class="cta-card">
        <h2>Need proof of onward travel?</h2>
        <p>Get a genuine, verifiable flight ticket reservation in minutes. A real airline booking reference you can show at check-in or with a visa application. No airfare paid unless you choose to fly.</p>
        <a href="/">Get a reservation &rarr;</a>
      </div>

      ${related.length ? `<div class="related">
        <p class="related-h">More guides</p>
        ${related.map((r) => `<a href="/blog/${esc(r.slug)}">${esc(r.title)} &rarr;</a>`).join("")}
      </div>` : ""}

      <a class="back-link" href="/blog">&larr; All guides</a>
    </article>
    ${renderSidebar(article, allArticles)}
    </div>`,
  });
}
