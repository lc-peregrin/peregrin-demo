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
import { seoTargetFor, liveLinks, linkLabel } from "./seo-targets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLOG_DIR = path.join(__dirname, "content", "blog");
// Spanish guides live in their own directory, served under /es/blog. Images are
// shared with the English guides, so they stay in content/blog/images.
const BLOG_ES_DIR = path.join(__dirname, "content", "blog-es");
const BLOG_IMAGE_DIR = path.join(BLOG_DIR, "images");
const DIR_FOR_LANG = { en: BLOG_DIR, es: BLOG_ES_DIR };
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

function readArticleFile(file, dir = BLOG_DIR) {
  const raw = fs.readFileSync(path.join(dir, file), "utf8");
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
    hasInlineDisclosure: /affiliate link|afiliados?/i.test(rest),
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

// Parsed-article cache. The guides are static between deploys, so parsing every
// markdown file's front-matter on every request was pure waste and the main
// cause of the TTFB regression once the guide count grew. The cache is keyed on
// a cheap signature (each file's name + mtime), so it self-invalidates when a
// file is added, removed or edited in local dev, and simply never invalidates
// in production where the filesystem is static for the process's lifetime.
const _listCache = new Map(); // lang -> { sig, articles }

function dirSignature(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return null;
  }
  // statSync is microseconds; it is the readFile + front-matter parse we are
  // avoiding, not the stat.
  return files
    .sort()
    .map((f) => `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`)
    .join("|");
}

export function listArticles(lang = "en") {
  const dir = DIR_FOR_LANG[lang] || BLOG_DIR;
  const sig = dirSignature(dir);
  if (sig === null) return [];
  const cached = _listCache.get(lang);
  // Same array reference is returned on a hit, which the perf test relies on to
  // prove nothing is re-parsed.
  if (cached && cached.sig === sig) return cached.articles;
  const files = sig.split("|").map((x) => x.slice(0, x.lastIndexOf(":")));
  const articles = files
    .map((f) => readArticleFile(f, dir))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  _listCache.set(lang, { sig, articles });
  return articles;
}

export function getArticle(slug, lang = "en") {
  return listArticles(lang).find((a) => a.slug === slug) || null;
}

// Slugs that exist in each language, used for hreflang pairing and for
// neutralising body links whose target is not published yet.
export function guideSlugs(lang = "en") {
  return listArticles(lang).map((a) => a.slug);
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

// Extra markup injected into every blog <head>, set once by the server so the
// analytics switch lives in exactly one place.
let BLOG_HEAD_EXTRA = "";
export function setBlogHeadExtra(html) { BLOG_HEAD_EXTRA = String(html || ""); }

// Guide search: a client-side filter over the guide registry. The registry is
// the list of published guides for the page's own language section, embedded as
// JSON at render time, so search can never surface an unpublished or
// wrong-language guide. No backend, no dependencies. When the visa hub page
// ships, its rows join this registry via the same entries.
const SEARCH_I18N = {
  en: { placeholder: "Search a country or guide…", noResults: "No guide for that yet" },
  es: { placeholder: "Busca un país o una guía…", noResults: "Aún no hay una guía para eso" },
  ru: { placeholder: "Поиск страны или гайда…", noResults: "Гайда по этой теме пока нет" },
  hi: { placeholder: "देश या गाइड खोजें…", noResults: "इसके लिए अभी कोई गाइड नहीं" },
};

const SEARCH_CSS = `
  .guide-search { position: relative; }
  .guide-search input { width: 100%; box-sizing: border-box; font: inherit; font-size: 14px; color: var(--ink);
    background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 9px 12px; }
  .guide-search input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(28,111,140,.12); }
  .guide-search-menu { display: none; position: absolute; z-index: 30; top: calc(100% + 5px); left: 0; right: 0;
    background: #fff; border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 10px 28px rgba(16,32,45,.12);
    max-height: 320px; overflow-y: auto; }
  .guide-search-menu.open { display: block; }
  .guide-search-menu a { display: block; padding: 9px 13px; font-size: 13.5px; font-weight: 600; color: var(--ink);
    text-decoration: none; border-top: 1px solid var(--line); }
  .guide-search-menu a:first-child { border-top: none; }
  .guide-search-menu a:hover, .guide-search-menu a.active { background: var(--accent-bg); color: var(--accent-dark); }
  .guide-search-menu .gs-none { display: block; padding: 9px 13px; font-size: 13px; color: var(--muted); }
  .header-search { width: 210px; margin-left: auto; margin-right: 14px; }
  .index-search { margin: 0 0 22px; max-width: 420px; }
  @media (max-width: 620px) { .header-search { display: none; } }
`;

// One behaviour everywhere: a dropdown of matching guides. On pages that also
// list guide cards (the index), matching additionally filters the cards live.
const SEARCH_SCRIPT = `<script>
(function () {
  var el = document.getElementById("guide-registry");
  if (!el) return;
  var REG, STR;
  try { REG = JSON.parse(el.textContent); STR = JSON.parse(document.getElementById("guide-search-i18n").textContent); }
  catch (e) { return; }
  var norm = function (s) {
    s = String(s || "").toLowerCase();
    try { s = s.normalize("NFD").replace(/[\\u0300-\\u036f]/g, ""); } catch (e) {}
    return s;
  };
  function wire(box) {
    var input = box.querySelector("input");
    var menu = box.querySelector(".guide-search-menu");
    if (!input || !menu) return;
    function close() { menu.classList.remove("open"); }
    function update() {
      var q = norm(input.value).trim();
      // Live-filter the index cards when present.
      var cards = document.querySelectorAll(".cards .card-post");
      for (var i = 0; i < cards.length; i++) {
        cards[i].style.display = !q || norm(cards[i].textContent).indexOf(q) > -1 ? "" : "none";
      }
      if (!q) { close(); return; }
      var hits = [];
      for (var j = 0; j < REG.length && hits.length < 8; j++) {
        if (norm(REG[j].t + " " + (REG[j].d || "")).indexOf(q) > -1) hits.push(REG[j]);
      }
      menu.innerHTML = hits.length
        ? hits.map(function (h) {
            return '<a href="' + h.u + '">' + h.t.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</a>";
          }).join("")
        : '<span class="gs-none">' + STR.noResults + "</span>";
      menu.classList.add("open");
    }
    input.addEventListener("input", update);
    input.addEventListener("focus", update);
    document.addEventListener("click", function (e) { if (!box.contains(e.target)) close(); });
    input.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
  }
  var boxes = document.querySelectorAll(".guide-search");
  for (var k = 0; k < boxes.length; k++) wire(boxes[k]);
})();
</script>`;

function searchSpec(articles, ctx) {
  return {
    str: SEARCH_I18N[ctx.lang] || SEARCH_I18N.en,
    registry: (articles || []).map((a) => ({
      t: a.heading || a.title,
      d: a.destination || "",
      u: `${ctx.blogBase}/${a.slug}`,
    })),
  };
}

function searchBoxHtml(cls, str) {
  return `<div class="guide-search ${cls}" role="search">
    <input type="search" placeholder="${esc(str.placeholder)}" aria-label="${esc(str.placeholder)}" autocomplete="off">
    <div class="guide-search-menu"></div>
  </div>`;
}

function shell({ title, description, canonical, lang, jsonLd, css, body, ogType = "website", ogImage = "", headExtra = "", nav = null, search = null }) {
  const ld = (jsonLd || []).map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join("\n");
  // Header/footer nav, localised. English default reproduces the original markup.
  const n = nav || { brandHref: "/", blogHref: "/blog", faqHref: "/faq", privacyHref: "/privacy",
    guides: "Guides", help: "Help &amp; FAQ", privacy: "Privacy Policy", showDisclaimer: true };
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
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#16283a">
${lang === "en" ? '<link rel="alternate" type="application/rss+xml" title="Peregrin Guides" href="/blog/feed.xml">' : ""}
<meta property="og:type" content="${esc(ogType)}">
<meta property="og:site_name" content="Peregrin">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(ogImage || `/og-image.png`)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(ogImage || `/og-image.png`)}">
${ld}
${headExtra}${BLOG_HEAD_EXTRA}
<style>${TOKENS}${FONTS}${BASE_CSS}${search ? SEARCH_CSS : ""}${css || ""}</style>
</head>
<body>
  <div class="wrap">
    <header class="site">
      <a class="brand" href="${n.brandHref}">
        <svg width="26" height="26" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <path d="M5 28C11 26 16 20 19 8" stroke="var(--accent)" stroke-width="4" stroke-linecap="round"/>
          <path d="M12 31C18 28 23 22 26 11" stroke="var(--accent)" stroke-width="4" stroke-linecap="round" opacity="0.55"/>
          <path d="M19 34C25 31 29 25 32 15" stroke="var(--gold)" stroke-width="4" stroke-linecap="round"/>
        </svg>
        <span class="mark">Peregrin</span>
      </a>
      ${search ? searchBoxHtml("header-search", search.str) : ""}<a class="header-link" href="${n.faqHref}">${n.help}</a>
    </header>
${body}
${search ? `<script type="application/json" id="guide-registry">${JSON.stringify(search.registry).replace(/</g, "\\u003c")}</script>
<script type="application/json" id="guide-search-i18n">${JSON.stringify(search.str).replace(/</g, "\\u003c")}</script>
${SEARCH_SCRIPT}` : ""}
    <footer class="site">
      <a href="${n.brandHref}">Peregrin</a> &middot; <a href="${n.blogHref}">${n.guides}</a> &middot; <a href="${n.faqHref}">${n.help}</a>
      &middot; <a href="${n.privacyHref}">${n.privacy}</a> &middot; <a href="mailto:hello@peregrin.travel">hello@peregrin.travel</a>
      ${n.showDisclaimer ? `<p class="foot-disclaimer">Peregrin provides genuine, verifiable flight reservations for legitimate
      proof-of-onward-travel, visa, and immigration documentation. A reservation is a held airline booking
      , not a purchased ticket and not travel; an e-ticket is issued only if you choose to confirm and
      pay the fare.</p>` : ""}
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

export function renderBlogIndex(articles, origin, ctx) {
  ctx = ctx || defaultCtx(articles, origin);
  const c = ctx.chrome;
  const canonical = `${origin}${ctx.blogBase}`;
  // English pulls its index title/meta/h1 from the SEO map; Spanish uses the
  // approved homepage guides strings, so no index copy is invented.
  const target = seoTargetFor("/blog") || {};
  const pageTitle = ctx.lang === "es" ? c.indexTitle : target.title;
  const pageMeta = ctx.lang === "es" ? c.indexMeta : target.meta;
  const pageH1 = ctx.lang === "es" ? c.indexH1 : target.h1;
  const readSuffix = c.readSuffix;
  const cards = articles.map((a) => `
      <a class="card-post" href="${ctx.blogBase}/${esc(a.slug)}">
        ${a.hero ? `<img class="card-img" src="${esc(a.hero)}" alt="${esc(a.heroAlt)}" loading="lazy" decoding="async" width="1600" height="800">` : ""}
        <div class="card-meta">
          ${a.destination ? `<span class="chip">${esc(a.destination)}</span>` : ""}
          ${a.readingTime ? `<span class="card-time">${esc(a.readingTime)} ${esc(readSuffix)}</span>` : ""}
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
      inLanguage: ctx.lang,
      url: canonical,
    },
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: articles.map((a, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: `${origin}${ctx.blogBase}/${a.slug}`,
        name: a.title,
      })),
    },
  ];

  // The blog index is a single-language listing per section, so it is
  // self-canonical and, like the guides, carries hreflang only once a
  // counterpart index exists (both /blog and /es/blog are live, so they pair).
  const indexAlternates = ctx.esSlugs.size && ctx.enSlugs.size
    ? `<link rel="alternate" hreflang="en" href="${origin}/blog">\n` +
      `<link rel="alternate" hreflang="es" href="${origin}/es/blog">\n` +
      `<link rel="alternate" hreflang="x-default" href="${origin}/blog">\n`
    : "";

  const search = searchSpec(articles, ctx);
  return shell({
    title: pageTitle,
    description: pageMeta,
    canonical,
    lang: ctx.lang,
    jsonLd,
    css: INDEX_CSS,
    headExtra: indexAlternates,
    nav: navFor(ctx),
    search,
    body: `
    <nav class="crumbs"><a href="${ctx.homeHref}">${esc(c.home)}</a> &rsaquo; <span>${esc(c.guides)}</span></nav>
    <p class="eyebrow">${esc(c.indexEyebrow)}</p>
    <h1 class="page">${esc(pageH1)}</h1>
    <p class="page-lede">${esc(c.indexLede)}</p>
    ${searchBoxHtml("index-search", search.str)}
    <div class="cards">${cards}</div>
    ${ctx.showFooter ? renderMappedLinks("/blog", articles) : ""}`,
  });
}

// --------------------------------------------------------------- article ----

const SIDEBAR_CSS = `
  .read-next { margin: 34px 0 0; padding: 18px 20px; background: #fff; border: 1px solid var(--line); border-radius: 12px; }
  .read-next-h { margin: 0 0 10px; font-size: 11px; font-weight: 700; letter-spacing: .08em;
    text-transform: uppercase; color: var(--accent); }
  .read-next a { display: block; font-size: 14px; font-weight: 600; line-height: 1.45; color: var(--ink);
    text-decoration: none; padding: 8px 0; border-top: 1px solid var(--line); }
  .read-next a:first-of-type { border-top: none; padding-top: 0; }
  .read-next a:hover { color: var(--accent); }

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

// Pulls question and answer pairs out of an article's FAQ section so the page
// can carry FAQPage schema. Questions are bold lines under an "## FAQ" heading,
// which is the shape every guide already uses, so no author has to do anything
// differently. Returns [] when a guide has no FAQ, and the schema is then simply
// not emitted rather than emitted empty.
export function extractFaq(body) {
  const start = body.search(/^##\s+(FAQ|Preguntas frecuentes)\s*$/mi);
  if (start === -1) return [];
  const rest = body.slice(start).split("\n");
  const out = [];
  let q = null;
  let a = [];
  const flush = () => {
    if (q && a.length) out.push({ q, a: a.join(" ").trim() });
    q = null;
    a = [];
  };
  for (const line of rest.slice(1)) {
    if (/^##\s+/.test(line)) break; // next section ends the FAQ
    const bold = line.match(/^\*\*(.+?)\*\*\s*$/);
    if (bold) {
      flush();
      q = bold[1].trim();
    } else if (q && line.trim()) {
      a.push(line.trim());
    } else if (!line.trim() && q && a.length) {
      flush();
    }
  }
  flush();
  return out;
}

// Renders the mapped internal links for a route, already filtered to the pages
// that exist. Returns "" when none are live yet, so a page never shows an empty
// "read next" box waiting for guides to be written.
function renderMappedLinks(route, articles) {
  const slugs = articles.map((a) => a.slug);
  const links = liveLinks(route, slugs);
  if (!links.length) return "";
  return `
      <nav class="read-next" aria-labelledby="read-next-h">
        <p class="read-next-h" id="read-next-h">Read next</p>
        ${links.map((l) => `<a href="${esc(l)}">${esc(linkLabel(l, articles))} &rarr;</a>`).join("")}
      </nav>`;
}

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
// ---------------------------------------------------------- localisation ----
//
// Blog chrome (navigation, sidebar, CTAs) per language. English reproduces the
// strings that used to be hardcoded, so English output is unchanged. Spanish
// uses safe UI labels for navigation and, for anything that makes a product
// claim, reuses copy already approved and shipped on the homepage rather than
// inventing new marketing text. The "Before you fly" checklist is substantive
// advice copy with no approved Spanish version, so it is omitted on Spanish
// guides (empty list) rather than machine-translated. Flagged in the report.
const CHROME = {
  en: {
    home: "Home", guides: "Guides", guideFallback: "Guide",
    readSuffix: "read", moreGuides: "More guides", allGuides: "All guides",
    sidebarPopular: "Popular guides",
    beforeFly: "Before you fly",
    checklist: [
      "Onward or return travel sorted, and verifiable if you are asked for it.",
      "Travel insurance that covers your whole trip, not just the first month.",
      "Somewhere booked for the first night, ideally free to cancel.",
      "Arrival card, e-visa or entry fee done in advance where your destination asks for one.",
    ],
    checkNote: "Requirements change and vary by nationality. Check your airline and destination before you travel.",
    needProof: "Need proof of onward travel?",
    ctaBody: "Get a genuine, verifiable flight ticket reservation in minutes. A real airline booking reference you can show at check-in or with a visa application. No airfare paid unless you choose to fly.",
    sideCtaBody: "A real, verifiable airline reservation in minutes. No airfare paid unless you choose to fly.",
    getReservation: "Get a reservation",
    indexEyebrow: "Guides",
    indexLede: "Clear, current guides to what border officials and airlines actually ask for, and the simplest way to satisfy it.",
  },
  es: {
    // Navigation labels: standard UI Spanish, not marketing or legal copy.
    home: "Inicio", guides: "Guías", guideFallback: "Guía",
    readSuffix: "de lectura", moreGuides: "Más guías", allGuides: "Todas las guías",
    sidebarPopular: "Guías populares",
    // Checklist omitted: no approved Spanish copy, and it is advice, not chrome.
    beforeFly: "", checklist: [], checkNote: "",
    // Reused from approved homepage Spanish (hero_eyebrow / hero_sub fragment /
    // the localised pack CTA). No new marketing copy is invented here.
    needProof: "Prueba de viaje de salida",
    sideCtaBody: "No pagas la tarifa aérea salvo que elijas volar.",
    getReservation: "Consigue tu reserva",
    // Reused from approved homepage guides_cta strings.
    indexEyebrow: "Guías",
    indexH1: "Lee nuestras guías de visados y viaje de salida",
    indexTitle: "Lee nuestras guías de visados y viaje de salida | Peregrin",
    indexMeta: "Lo que piden realmente los agentes de frontera y los consulados, país por país, y la forma sencilla de cumplirlo.",
    indexLede: "Lo que piden realmente los agentes de frontera y los consulados, país por país.",
  },
};

// Body links to guides that are not published yet must not render as 404s. Any
// internal blog link whose target is not in the live set is unwrapped to plain
// text, exactly like an unfilled affiliate slot, so it self-activates the moment
// that guide is published. Applies to both /blog and /es/blog links.
export function neutralizeDeadLinks(html, liveRoutes) {
  if (!liveRoutes) return html;
  return html.replace(
    /<a href="(\/(?:es\/)?blog\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/g,
    (whole, href, text) => (liveRoutes.has(href.replace(/\/$/, "")) ? whole : text)
  );
}

// hreflang cluster for a guide, keyed by slug across languages. Emitted only
// when the slug exists in more than one language: a single-language page has no
// alternate to declare, and a self-only hreflang adds nothing. When the
// counterpart is published later, both pages pick each other up automatically,
// the same self-activating pattern used for internal links.
function guideAlternates(slug, ctx) {
  const langs = [];
  if (ctx.enSlugs.has(slug)) langs.push("en");
  if (ctx.esSlugs.has(slug)) langs.push("es");
  if (langs.length < 2) return "";
  const href = (l) => `${ctx.origin}${l === "es" ? "/es/blog/" : "/blog/"}${slug}`;
  const tags = langs.map((l) => `<link rel="alternate" hreflang="${l}" href="${href(l)}">`);
  // x-default points at the original (English) where it exists.
  tags.push(`<link rel="alternate" hreflang="x-default" href="${href(langs.includes("en") ? "en" : langs[0])}">`);
  return tags.join("\n") + "\n";
}

// Builds the rendering context for a language's blog. English defaults keep the
// original behaviour; Spanish flips the base paths, chrome, and footer handling
// (Spanish guides carry their own related-guides list and closing CTA in the
// body, so the template footer is suppressed to avoid duplication).
export function buildBlogCtx(lang, { enSlugs = [], esSlugs = [], origin = "" } = {}) {
  const isEs = lang === "es";
  const liveRoutes = new Set([
    "/blog", "/es/blog",
    ...enSlugs.map((s) => `/blog/${s}`),
    ...esSlugs.map((s) => `/es/blog/${s}`),
  ]);
  return {
    lang: isEs ? "es" : "en",
    blogBase: isEs ? "/es/blog" : "/blog",
    homeHref: isEs ? "/es" : "/",
    chrome: isEs ? CHROME.es : CHROME.en,
    showFooter: !isEs,
    liveRoutes,
    origin,
    enSlugs: new Set(enSlugs),
    esSlugs: new Set(esSlugs),
  };
}

// Default English context from a rendered list, so renderArticle/renderBlogIndex
// still work when called with three arguments (the test signature).
// Localised header/footer nav for the shell, built from the blog context. Help
// and Privacy point at the English pages because there are no Spanish versions
// of those; a Spanish reader lands there and can use the language switcher.
function navFor(ctx) {
  const es = ctx.lang === "es";
  return {
    brandHref: ctx.homeHref,
    blogHref: ctx.blogBase,
    faqHref: "/faq",
    privacyHref: "/privacy",
    guides: es ? "Gu\u00edas" : "Guides",
    help: es ? "Ayuda" : "Help &amp; FAQ",
    privacy: es ? "Privacidad" : "Privacy Policy",
    showDisclaimer: !es,
  };
}

function defaultCtx(allArticles, origin) {
  return buildBlogCtx("en", { enSlugs: allArticles.map((a) => a.slug), esSlugs: [], origin });
}

function renderSidebar(article, allArticles, ctx) {
  const c = ctx.chrome;
  const others = allArticles.filter((a) => a.slug !== article.slug);
  const popular = others.length
    ? `<nav class="side-box" aria-labelledby="side-guides-h">
        <p class="side-h" id="side-guides-h">${esc(c.sidebarPopular)}</p>
        <ul class="side-list">
          ${others.map((a) => `<li><a href="${ctx.blogBase}/${esc(a.slug)}">${esc(a.heading || a.title)}</a></li>`).join("")}
        </ul>
      </nav>`
    : "";

  // Deliberately generic: these are the four things that actually stop people at
  // a gate or a border, and none of them claims to be immigration advice. Only
  // rendered where the language has approved checklist copy.
  const checklist = c.checklist && c.checklist.length
    ? `
      <aside class="side-box side-check" aria-labelledby="side-check-h">
        <p class="side-h" id="side-check-h">${esc(c.beforeFly)}</p>
        <ul class="side-check-list">
          ${c.checklist.map((i) => `<li>${esc(i)}</li>`).join("")}
        </ul>
        <p class="side-note">${esc(c.checkNote)}</p>
      </aside>`
    : "";

  const cta = `
      <aside class="side-box side-cta">
        <p class="side-h">${esc(c.needProof)}</p>
        <p class="side-cta-d">${esc(c.sideCtaBody)}</p>
        <a href="${ctx.homeHref}">${esc(c.getReservation)} &rarr;</a>
      </aside>`;

  return `<div class="sidebar">${popular}${checklist}${cta}</div>`;
}

export function renderArticle(article, allArticles, origin, ctx) {
  ctx = ctx || defaultCtx(allArticles, origin);
  const c = ctx.chrome;
  const canonical = `${origin}${ctx.blogBase}/${article.slug}`;
  const route = `${ctx.blogBase}/${article.slug}`;
  // On-page targets win over front-matter where the map specifies one, so the
  // SEO spec is the single source of truth for what search engines see. Only the
  // English guides have map entries; Spanish guides fall back to their
  // front-matter title/meta/heading, which are already in Spanish.
  const target = seoTargetFor(route) || {};
  const pageTitle = target.title || article.title;
  const pageMeta = target.meta || article.description;
  const pageH1 = target.h1 || article.heading;
  const faq = extractFaq(article.body);
  // Related is the fallback for guides the map has no entry for; mapped links
  // take precedence when any of them are live.
  const related = allArticles.filter((a) => a.slug !== article.slug).slice(0, 3);

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: pageTitle,
      description: pageMeta,
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
      // ImageObject with dimensions is what Google wants for image rich results;
      // heroes are all 1600x800. Falls back to the site image when a guide has
      // no hero (never happens now, but kept safe).
      image: article.hero
        ? { "@type": "ImageObject", url: `${origin}${article.hero}`, width: 1600, height: 800 }
        : `${origin}/og-image.png`,
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: c.home, item: `${origin}${ctx.homeHref}` },
        { "@type": "ListItem", position: 2, name: c.guides, item: `${origin}${ctx.blogBase}` },
        { "@type": "ListItem", position: 3, name: article.heading, item: canonical },
      ],
    },
    // Only emitted when the guide really has an FAQ section. Marking up
    // questions that are not on the page is a structured-data violation.
    ...(faq.length
      ? [{
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: faq.map((f) => ({
            "@type": "Question",
            name: f.q,
            acceptedAnswer: { "@type": "Answer", text: f.a },
          })),
        }]
      : []),
  ];

  const metaBits = [formatDate(article.date), article.readingTime ? `${article.readingTime} ${c.readSuffix}` : ""]
    .filter(Boolean).join(" &middot; ");
  // Body links to guides that are not published yet are unwrapped so nothing
  // points at a 404, in either language.
  const bodyHtml = neutralizeDeadLinks(renderArticleBody(article.body), ctx.liveRoutes);

  return shell({
    title: pageTitle,
    description: pageMeta,
    canonical,
    lang: article.lang,
    jsonLd,
    css: ARTICLE_CSS,
    ogType: "article",
    ogImage: article.hero ? `${origin}${article.hero}` : "",
    headExtra: guideAlternates(article.slug, ctx),
    nav: navFor(ctx),
    search: searchSpec(allArticles, ctx),
    body: `
    <nav class="crumbs"><a href="${ctx.homeHref}">${esc(c.home)}</a> &rsaquo; <a href="${ctx.blogBase}">${esc(c.guides)}</a> &rsaquo; <span>${esc(article.destination || c.guideFallback)}</span></nav>
    <div class="article-layout">
    <article>
      <h1 class="page">${esc(pageH1)}</h1>
      <p class="article-meta">${metaBits}</p>
      ${article.hero ? `<figure class="hero-figure">
        <img src="${esc(article.hero)}" alt="${esc(article.heroAlt)}" width="1600" height="800" decoding="async" fetchpriority="high">
      </figure>` : ""}
      ${article.hasAffiliate && !article.hasInlineDisclosure ? `<p class="affiliate-note">${esc(AFFILIATE_DISCLOSURE)}</p>` : ""}
      <div class="prose">${bodyHtml}</div>
      ${ctx.showFooter ? renderRecommendedBox(article.recommend) : ""}
      ${ctx.showFooter ? renderMappedLinks(route, allArticles) : ""}

      ${ctx.showFooter ? `<div class="cta-card">
        <h2>${esc(c.needProof)}</h2>
        <p>${esc(c.ctaBody)}</p>
        <a href="${ctx.homeHref}">${esc(c.getReservation)} &rarr;</a>
      </div>` : ""}

      ${ctx.showFooter && related.length ? `<div class="related">
        <p class="related-h">${esc(c.moreGuides)}</p>
        ${related.map((r) => `<a href="${ctx.blogBase}/${esc(r.slug)}">${esc(r.title)} &rarr;</a>`).join("")}
      </div>` : ""}

      <a class="back-link" href="${ctx.blogBase}">&larr; ${esc(c.allGuides)}</a>
    </article>
    ${renderSidebar(article, allArticles, ctx)}
    </div>
<script>
(function () {
  var track = function (n, p) {
    try { if (typeof window.peregrinTrack === "function") window.peregrinTrack(n, p); } catch (e) {}
  };
  var slug = ${JSON.stringify(article.slug)};

  // guide_read: fired once, when the reader has actually got through half the
  // article. Firing on load would count bounces as reads.
  var read = false;
  var onScroll = function () {
    if (read) return;
    var d = document.documentElement;
    var depth = (window.scrollY + window.innerHeight) / Math.max(d.scrollHeight, 1);
    if (depth >= 0.5) {
      read = true;
      track("guide_read", { slug: slug });
      window.removeEventListener("scroll", onScroll);
    }
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // guide_to_product_click: any link from a guide back into the product. This
  // is the number that says whether the blog actually earns its keep.
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (href === "/" || href.indexOf("/#") === 0 || href.indexOf("/?") === 0) {
      track("guide_to_product_click", { slug: slug, href: href });
    }
  }, true);
})();
</script>`,
  });
}
