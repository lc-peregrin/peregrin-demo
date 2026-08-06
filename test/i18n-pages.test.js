// Multilingual URL tests.
//
// The homepage shipped four real translations but only one URL, with
// `<html lang="en">` hardcoded and the text swapped by JavaScript after load.
// Search engines only ever saw English, so the Spanish, Russian and Hindi copy
// could not rank at all. These tests pin the fix: each language has its own
// crawlable URL whose HTML arrives already translated, with a correct lang
// attribute and a complete hreflang cluster.
//
// They also pin the scope limit. The guides are English-only, so they must NOT
// get language alternates: claiming a Spanish version of an English page is
// worse than claiming none.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderIndexForLang, hreflangTags, LANGS, LANG_PATHS, LOCALISED_PACKS } from "../i18n-pages.js";
import { listArticles, renderArticle } from "../blog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "https://www.peregrin.travel";
const pages = Object.fromEntries(LANGS.map((l) => [l, renderIndexForLang(l, { origin: ORIGIN })]));

test("every language has its own URL and English stays at the root", () => {
  assert.equal(LANG_PATHS.en, "/");
  for (const l of LANGS.filter((x) => x !== "en")) {
    assert.equal(LANG_PATHS[l], `/${l}`, `${l} needs its own path`);
  }
});

test("the html lang attribute matches the language actually served", () => {
  for (const l of LANGS) {
    assert.match(pages[l], new RegExp(`<html lang="${l}">`), `${l}: wrong or missing lang attribute`);
    // Exactly one, so nothing downstream re-declares it.
    assert.equal((pages[l].match(/<html lang=/g) || []).length, 1);
  }
});

test("the HTML arrives translated, without needing JavaScript", () => {
  // This is the whole point: a crawler that does not run our script must still
  // see Spanish on /es.
  const h1 = (html) => html.match(/<h1 data-i18n="hero_h1">(.*?)<\/h1>/)[1];
  assert.match(h1(pages.en), /verifiable flight reservation/i);
  assert.match(h1(pages.es), /reserva de vuelo verificable/i);
  assert.match(h1(pages.ru), /[Ѐ-ӿ]{4,}/, "Russian page must contain Cyrillic");
  assert.match(h1(pages.hi), /[ऀ-ॿ]{4,}/, "Hindi page must contain Devanagari");
  // And the English page's markup is untouched. Scoped to the markup before the
  // app script, since the script legitimately contains every translation.
  // Body markup only: the head and the app script both legitimately contain
  // every language, so slice between <body> and the app script.
  const markupOnly = (html) => html.slice(html.indexOf("<body>"), html.lastIndexOf("<script>"));
  assert.ok(!/reserva de vuelo/i.test(markupOnly(pages.en)), "English markup must stay English");
  assert.ok(/reserva de vuelo/i.test(markupOnly(pages.es)), "Spanish markup must be translated");
});

test("translation never mangles markup", () => {
  for (const l of LANGS) {
    // Same number of elements and the same tag structure as the source.
    const src = readFileSync(join(__dirname, "..", "public", "index.html"), "utf8");
    const count = (h, re) => (h.match(re) || []).length;
    assert.equal(count(pages[l], /data-i18n="/g), count(src, /data-i18n="/g), `${l}: lost a translatable element`);
    assert.equal(count(pages[l], /<script/g), count(src, /<script/g) + 1, `${l}: script tags changed unexpectedly`);
    assert.equal(count(pages[l], /<\/div>/g), count(src, /<\/div>/g), `${l}: div structure changed`);
  }
});

test("each language page carries the full hreflang cluster including x-default", () => {
  for (const l of LANGS) {
    for (const other of LANGS) {
      assert.ok(
        pages[l].includes(`hreflang="${other}" href="${ORIGIN}${LANG_PATHS[other]}"`),
        `${l}: missing alternate for ${other}`
      );
    }
    assert.ok(pages[l].includes(`hreflang="x-default"`), `${l}: x-default is required`);
    // Alternates must be absolute URLs or Google ignores them.
    for (const m of pages[l].matchAll(/rel="alternate" hreflang="[^"]+" href="([^"]+)"/g)) {
      assert.match(m[1], /^https?:\/\//, `${l}: hreflang href must be absolute, got ${m[1]}`);
    }
  }
});

test("hreflang is reciprocal, which is what makes the annotations count", () => {
  // Every page in the cluster must list every other page, including itself.
  const tags = hreflangTags(ORIGIN);
  for (const l of LANGS) assert.ok(tags.includes(`${ORIGIN}${LANG_PATHS[l]}`), `cluster is missing ${l}`);
});

test("each language page is self-canonical, not canonical to English", () => {
  // Pointing /es at / would tell Google the Spanish page is a duplicate and
  // undo the whole exercise.
  for (const l of LANGS) {
    assert.ok(
      pages[l].includes(`<link rel="canonical" href="${ORIGIN}${LANG_PATHS[l]}">`),
      `${l}: must be canonical to itself`
    );
    assert.equal((pages[l].match(/rel="canonical"/g) || []).length, 1, `${l}: exactly one canonical`);
  }
});

test("og:url follows the language URL too", () => {
  for (const l of LANGS) {
    assert.ok(pages[l].includes(`<meta property="og:url" content="${ORIGIN}${LANG_PATHS[l]}">`), `${l}: og:url`);
  }
});

test("guides are English-only and claim no language alternates", () => {
  // There are no translated guides. Serving English prose under a Spanish URL,
  // or claiming a Spanish alternate that does not exist, is worse than nothing.
  const articles = listArticles();
  for (const a of articles) {
    const html = renderArticle(a, articles, ORIGIN);
    assert.doesNotMatch(html, /rel="alternate" hreflang/, `${a.slug}: must not claim language alternates`);
    assert.match(html, /<html lang="en">/, `${a.slug}: guides are in English`);
  }
});

test("the language switcher keeps URL and content in agreement", () => {
  const src = readFileSync(join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(src, /window\.__PEREGRIN_LANG__/, "the served URL must win over remembered choice");
  assert.match(src, /location\.assign\(target\)/, "switching language must move to that language's URL");
  // Only on pages that have language URLs; elsewhere the in-place swap is right.
  assert.match(src, /isLangUrl && target && target !== here/);
});

test("every language page still has exactly one H1", () => {
  for (const l of LANGS) {
    assert.equal((pages[l].match(/<h1[\s>]/g) || []).length, 1, `${l}: exactly one H1`);
  }
});

test("language pages carry localised title and description, not English ones", () => {
  // An English title on a Spanish page wastes the translation. These reuse the
  // already-approved translated hero strings rather than inventing new copy.
  for (const l of LANGS.filter((x) => x !== "en")) {
    const title = pages[l].match(/<title>(.*?)<\/title>/)[1];
    const desc = pages[l].match(/name="description" content="([^"]*)"/)[1];
    assert.ok(!/Verifiable Flight Reservations for Visa/.test(title), `${l}: title is still English`);
    assert.ok(title.length < 60, `${l}: title is ${title.length} chars`);
    assert.ok(desc.length < 155, `${l}: description is ${desc.length} chars`);
    assert.ok(!/Get a genuine, verifiable flight reservation/.test(desc), `${l}: description is still English`);
  }
  // English is unchanged and still matches the map.
  assert.match(pages.en, /<title>Verifiable Flight Reservations for Visa &amp; Onward Travel \| Peregrin<\/title>/);
});

test("/faq is canonical to itself and borrows no language alternates", () => {
  // It shares the app shell with the homepage but is its own URL. Inheriting the
  // homepage canonical would declare it a duplicate and deindex it, while it is
  // simultaneously listed in the sitemap.
  const faq = renderIndexForLang("en", { origin: ORIGIN, canonicalPath: "/faq", includeHreflang: false });
  assert.ok(faq.includes(`<link rel="canonical" href="${ORIGIN}/faq">`), "must be canonical to itself");
  assert.equal((faq.match(/rel="canonical"/g) || []).length, 1);
  assert.doesNotMatch(faq, /rel="alternate" hreflang/, "only the homepage cluster has language URLs");
});

test("language pages localise the Organization JSON-LD description and it still parses", () => {
  for (const lang of ["es", "ru", "hi"]) {
    const html = renderIndexForLang(lang, { origin: ORIGIN });
    const blocks = [...html.matchAll(/application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const org = blocks.find((b) => b["@type"] === "Organization");
    assert.ok(org, `${lang}: Organization block must exist`);
    assert.equal(org.description, LOCALISED_PACKS[lang].meta,
      `${lang}: JSON-LD description must be the verified pack string`);
  }
  // English keeps its own description untouched.
  const en = renderIndexForLang("en", { origin: ORIGIN });
  assert.match(en, /"description": "Genuine, verifiable flight reservations held directly/);
});

test("RU and HI packs are marked native-speaker reviewed", () => {
  assert.equal(LOCALISED_PACKS.ru.reviewed, true);
  assert.equal(LOCALISED_PACKS.hi.reviewed, true);
});
