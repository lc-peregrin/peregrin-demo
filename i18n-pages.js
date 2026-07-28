// Server-rendered language versions of the homepage.
//
// WHY THIS EXISTS
// The homepage ships real translations for four languages, but they were only
// ever applied in the browser: one URL, `<html lang="en">` hardcoded, and the
// text swapped by JavaScript after load. Search engines therefore only ever saw
// the English version, so the Spanish, Russian and Hindi copy could not rank at
// all. This gives each language a real crawlable URL whose HTML arrives already
// translated, rather than relying on a crawler executing our JavaScript.
//
// SCOPE, DELIBERATELY LIMITED
// Only pages that have genuine translations get a language URL. The guides are
// English-only, so there are no /es/blog/... routes: serving English prose under
// a Spanish URL would be duplicate content pointing at a page that is not
// actually in that language, which is worse than having no alternate at all.

import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, "public", "index.html");

// English lives at the root; the others get a path prefix.
export const LANGS = ["en", "es", "ru", "hi"];
export const LANG_PATHS = { en: "/", es: "/es", ru: "/ru", hi: "/hi" };
// Region-neutral hreflang codes; these are language targets, not country ones.
const HREFLANG = { en: "en", es: "es", ru: "ru", hi: "hi" };

// Localised homepage packs supplied by Cowork in
// cowork-drafts/NEW_ANGLE_AND_LOCALISED_COPY.md. Title and meta are applied
// verbatim; the H1 and subhead come from the translations dictionary in
// index.html (hero_h1, hero_angle), so they are not duplicated here.
//
// RU and HI are careful drafts pending native-speaker review. They are wired in
// so the pages are complete, but must be confirmed before they are treated as
// final. See MORNING_REPORT / OVERNIGHT_LOG.
export const LOCALISED_PACKS = {
  es: {
    title: "Reserva de Vuelo Verificable para Visado y Salida",
    meta: "Consigue una reserva de vuelo real y verificable en minutos, con localizador que puedes comprobar, como prueba de billete de salida para visado e inmigracion.",
    reviewed: true,
  },
  ru: {
    title: "Подтверждаемая бронь авиабилета для визы",
    meta: "Получите настоящую подтверждаемую бронь авиабилета за минуты: реальное бронирование с кодом PNR как подтверждение вылета для визы и паспортного контроля.",
    reviewed: false,
  },
  hi: {
    title: "वीज़ा के लिए सत्यापन-योग्य फ्लाइट रिज़र्वेशन",
    meta: "मिनटों में असली, सत्यापन-योग्य फ्लाइट रिज़र्वेशन पाएं, PNR के साथ जिसे आप जांच सकते हैं, वीज़ा और इमिग्रेशन के लिए आगे की यात्रा का प्रमाण।",
    reviewed: false,
  },
};

// English-only benefit bullet for the homepage "why a reservation" area. Cowork
// has not supplied localised versions, so it is injected only on the English
// homepage; an English bullet on a translated page would be worse than none.
const HOME_BENEFIT_BULLET_EN =
  '<p class="benefit-callout">Do not get held up at check-in over a missing onward ticket. ' +
  "A genuine, verifiable reservation is real proof you can show at the gate and the immigration desk, " +
  "at a fraction of what a flight you will not fly would cost.</p>";

// Pulls the translations object literal out of the inline script and evaluates
// it in an empty sandbox. It is our own file and contains only data, but the
// sandbox means a syntax error surfaces here rather than corrupting a page.
function extractTranslations(html) {
  const start = html.indexOf("const translations = {");
  if (start === -1) return null;
  const open = html.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return null;
  try {
    return vm.runInNewContext(`(${html.slice(open, end)})`, {}, { timeout: 1000 });
  } catch {
    return null;
  }
}

function escapeAttr(v) {
  return String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
// Trims to a length without cutting a word in half.
function truncateAtWord(v, max) {
  const str = String(v);
  if (str.length <= max) return str;
  const cut = str.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > 40 ? cut.slice(0, sp) : cut).replace(/[,;:]$/, "") + "...";
}

function escapeText(v) {
  return String(v).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// Replaces the text of every data-i18n element with the target language. Only
// elements whose content is plain text are touched; anything containing nested
// markup is left alone and the client-side applyLang() still handles it, so this
// can never mangle structure.
function translateMarkup(html, dict) {
  if (!dict) return html;
  return html.replace(
    /(<([a-zA-Z][\w-]*)[^>]*\bdata-i18n="([^"]+)"[^>]*>)([^<]*)(<\/\2>)/g,
    (whole, openTag, tag, key, body, closeTag) => {
      const value = dict[key];
      if (typeof value !== "string") return whole;
      return `${openTag}${escapeText(value)}${closeTag}`;
    }
  );
}

// The hreflang cluster. Every language page lists every other one plus
// x-default, and each points at an absolute URL, which is what Google requires
// for the annotations to be honoured.
export function hreflangTags(origin) {
  const tags = LANGS.map(
    (l) => `<link rel="alternate" hreflang="${HREFLANG[l]}" href="${escapeAttr(origin + LANG_PATHS[l])}">`
  );
  // x-default is the page for anyone whose language we do not target.
  tags.push(`<link rel="alternate" hreflang="x-default" href="${escapeAttr(origin + LANG_PATHS.en)}">`);
  return tags.join("\n");
}

let cache = { mtime: 0, translations: null };
function translationsFor(html, mtime) {
  if (mtime !== cache.mtime) cache = { mtime, translations: extractTranslations(html) };
  return cache.translations;
}

// Pulls the client-rendered FAQ copy (const faqData = {...} in the inline
// script) the same way extractTranslations does, so the FAQPage JSON-LD served
// on /faq is generated from the one source of truth and can never drift from
// what the page actually shows. Returns "" when anything is off — a missing
// schema is harmless, a wrong one is a structured-data violation.
function extractObjectLiteral(html, marker) {
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const open = html.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) {
      try {
        return vm.runInNewContext(`(${html.slice(open, i + 1)})`, {}, { timeout: 1000 });
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function faqPageSchema(lang = "en") {
  const raw = fs.readFileSync(INDEX_PATH, "utf8");
  const data = extractObjectLiteral(raw, "const faqData = {");
  const faqs = data && data[lang] && Array.isArray(data[lang].faqs) ? data[lang].faqs : null;
  if (!faqs || !faqs.length) return "";
  const schema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
  return `<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, "\\u003c")}</script>`;
}

// Builds the served HTML for one language.
export function renderIndexForLang(lang, { origin, headExtra = "", homeLinks = "", canonicalPath = null, includeHreflang = true } = {}) {
  const { mtimeMs } = fs.statSync(INDEX_PATH);
  const raw = fs.readFileSync(INDEX_PATH, "utf8");
  const all = translationsFor(raw, mtimeMs);
  const dict = all && all[lang];

  let html = lang === "en" ? raw : translateMarkup(raw, dict);

  // The document's own language must match what is actually on the page.
  html = html.replace(/<html lang="[^"]*">/, `<html lang="${escapeAttr(lang)}">`);

  // Title and meta on a language page. SEO_TARGET_MAP.md only specifies English
  // targets, and inventing marketing copy in three languages is not this
  // module's job, so these reuse the translated hero strings that are already
  // approved and shipped. An English title on a Spanish page is worse than a
  // reused Spanish one. Proper localised titles can replace this when supplied.
  // Title and meta come from the Cowork-supplied localised pack. These are the
  // proper localised SEO strings, so they replace the earlier stopgap that
  // reused the hero copy.
  const pack = lang !== "en" ? LOCALISED_PACKS[lang] : null;
  if (pack) {
    if (pack.title) {
      html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeText(pack.title)}</title>`);
      html = html.replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${escapeAttr(pack.title)}">`);
      html = html.replace(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${escapeAttr(pack.title)}">`);
    }
    if (pack.meta) {
      const desc = truncateAtWord(pack.meta, 154);
      html = html.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${escapeAttr(desc)}">`);
      html = html.replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${escapeAttr(desc)}">`);
      html = html.replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${escapeAttr(desc)}">`);
      html = html.replace(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${escapeAttr(desc)}">`);
    }
  }

  // Other views of the same app (notably /faq) share this shell but are their
  // own URL, so they must be canonical to themselves. Inheriting the homepage
  // canonical would declare them duplicates and deindex them.
  const canonical = origin + (canonicalPath || LANG_PATHS[lang]);
  html = html.replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${escapeAttr(canonical)}">`);
  html = html.replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${escapeAttr(canonical)}">`);

  // Alternates go next to the canonical. Only the homepage cluster has language
  // URLs, so a view like /faq gets none rather than borrowing the homepage's.
  const alternates = includeHreflang ? `${hreflangTags(origin)}\n` : "";
  html = html.replace("</head>", `${alternates}${headExtra}\n</head>`);

  // Tell the client which language this URL is, before the app boots, so it does
  // not immediately re-apply a different remembered language and flicker.
  html = html.replace(
    "<body>",
    `<body>\n<script>window.__PEREGRIN_LANG__=${JSON.stringify(lang)};try{localStorage.setItem("peregrin_lang",${JSON.stringify(lang)});}catch(e){}</script>`
  );

  html = html.replace("<!--SEO_HOME_LINKS-->", homeLinks);
  // English-only: see HOME_BENEFIT_BULLET_EN.
  html = html.replace("<!--HOME_BENEFIT_BULLET-->", lang === "en" ? HOME_BENEFIT_BULLET_EN : "");
  return html;
}

export function isLangPath(lang) {
  return Object.prototype.hasOwnProperty.call(LANG_PATHS, lang) && lang !== "en";
}
