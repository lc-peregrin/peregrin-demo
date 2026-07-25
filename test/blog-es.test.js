// Spanish guide section tests.
//
// The Spanish guides are served at /es/blog through the same renderer as the
// English guides, with a Spanish context. These tests pin the things that make
// that safe: the pages are genuinely in Spanish (lang, self-canonical, no
// English chrome leaking in), the affiliate and FAQ machinery recognises the
// Spanish wording, and no body link points at a guide that is not published in
// Spanish yet.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listArticles, renderArticle, renderBlogIndex, buildBlogCtx, guideSlugs,
  neutralizeDeadLinks, extractFaq,
} from "../blog.js";

const ORIGIN = "https://www.peregrin.travel";
const esArticles = listArticles("es");
const enArticles = listArticles("en");
const ctxEs = buildBlogCtx("es", { enSlugs: guideSlugs("en"), esSlugs: guideSlugs("es"), origin: ORIGIN });
const ctxEn = buildBlogCtx("en", { enSlugs: guideSlugs("en"), esSlugs: guideSlugs("es"), origin: ORIGIN });

test("the nine Spanish guides load", () => {
  assert.equal(esArticles.length, 9, "expected the nine Spanish drafts");
  for (const a of esArticles) {
    assert.equal(a.lang, "es", `${a.slug}: front-matter lang must be es`);
    assert.ok(a.title && a.heading && a.description, `${a.slug}: front-matter incomplete`);
    assert.match(a.readingTime, /^\d+ min$/, `${a.slug}: reading time must be normalised`);
    assert.equal(a.date, "2026-07-25", `${a.slug}: date must be normalised`);
  }
});

test("a Spanish guide renders in Spanish and is self-canonical", () => {
  const a = esArticles.find((x) => x.slug === "proof-of-onward-travel-mexico");
  const html = renderArticle(a, esArticles, ORIGIN, ctxEs);
  assert.match(html, /<html lang="es">/, "must declare Spanish");
  assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN}/es/blog/proof-of-onward-travel-mexico">`),
    "must be canonical to its own /es URL");
  // Chrome is Spanish and English chrome does not leak into the page.
  assert.ok(html.includes(">Inicio<") && html.includes(">Guías<"), "crumbs must be Spanish");
  assert.ok(html.includes("Todas las guías"), "back link must be Spanish");
  for (const enChrome of ["Popular guides", "Before you fly", "All guides", "More guides",
    "Need proof of onward travel?", "Get a reservation"]) {
    assert.ok(!html.includes(enChrome), `English chrome leaked: ${enChrome}`);
  }
  // Reading-time suffix is localised.
  assert.match(html, /min de lectura/, "reading time suffix must be Spanish");
});

test("the Spanish index lists the guides and links under /es/blog", () => {
  const html = renderBlogIndex(esArticles, ORIGIN, ctxEs);
  assert.match(html, /<html lang="es">/);
  assert.ok(html.includes(`rel="canonical" href="${ORIGIN}/es/blog"`), "self-canonical");
  assert.equal((html.match(/class="card-post" href="\/es\/blog\//g) || []).length, esArticles.length,
    "every card links under /es/blog");
  assert.equal((html.match(/<h1/g) || []).length, 1, "exactly one h1");
  assert.ok(!html.includes('href="/blog/'), "must not link to the English section");
});

test("Spanish guides carry no English affiliate banner, since the body discloses inline", () => {
  // The Spanish bodies include SafetyWing links and a Spanish inline disclosure
  // ("enlaces de afiliado"). The English AFFILIATE_DISCLOSURE banner must not be
  // stacked on top of it.
  for (const a of esArticles.filter((x) => x.body.includes("safetywing.com"))) {
    assert.ok(a.hasInlineDisclosure, `${a.slug}: Spanish inline disclosure must be detected`);
    const html = renderArticle(a, esArticles, ORIGIN, ctxEs);
    assert.doesNotMatch(html, /class="affiliate-note"/, `${a.slug}: no English banner on a Spanish page`);
    assert.match(html, /afiliados?/, `${a.slug}: the Spanish inline disclosure must remain`);
  }
});

test("Spanish FAQ sections produce FAQPage schema", () => {
  const withFaq = esArticles.filter((a) => /## Preguntas frecuentes/i.test(a.body));
  assert.ok(withFaq.length >= 5, "most Spanish guides have an FAQ");
  for (const a of withFaq) {
    assert.ok(extractFaq(a.body).length >= 2, `${a.slug}: FAQ must parse`);
    const html = renderArticle(a, esArticles, ORIGIN, ctxEs);
    const ld = [...html.matchAll(/application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]));
    assert.ok(ld.some((l) => l["@type"] === "FAQPage"), `${a.slug}: FAQPage schema required`);
  }
});

test("no rendered Spanish page links to a guide that is not published in Spanish", () => {
  const liveEs = new Set(guideSlugs("es"));
  const pages = [renderBlogIndex(esArticles, ORIGIN, ctxEs),
    ...esArticles.map((a) => renderArticle(a, esArticles, ORIGIN, ctxEs))];
  for (const html of pages) {
    for (const m of html.matchAll(/href="\/es\/blog\/([a-z0-9-]+)"/g)) {
      assert.ok(liveEs.has(m[1]), `link to an unpublished Spanish guide: /es/blog/${m[1]}`);
    }
  }
});

test("dead body links are unwrapped to text, and live ones stay links", () => {
  const live = new Set(["/es/blog/dummy-ticket-visa-application"]);
  const html = neutralizeDeadLinks(
    '<p><a href="/es/blog/dummy-ticket-visa-application">A</a> and ' +
    '<a href="/es/blog/proof-of-onward-travel-vietnam">B</a></p>', live);
  assert.match(html, /<a href="\/es\/blog\/dummy-ticket-visa-application">A<\/a>/, "live link kept");
  assert.ok(!/href="\/es\/blog\/proof-of-onward-travel-vietnam"/.test(html), "dead link unwrapped");
  assert.match(html, /and B</, "dead link text is preserved");
});

test("a guide gains hreflang only when both language versions exist", () => {
  // No Spanish slug currently matches a live English slug, so no guide emits
  // hreflang yet. This proves the machinery, and that it self-activates.
  const noPair = renderArticle(esArticles[0], esArticles, ORIGIN, ctxEs);
  assert.doesNotMatch(noPair, /rel="alternate" hreflang/, "no counterpart, so no hreflang");

  // Simulate the English counterpart of a Spanish guide being published.
  const slug = esArticles[0].slug;
  const ctxPaired = buildBlogCtx("es", { enSlugs: [slug], esSlugs: [slug], origin: ORIGIN });
  const paired = renderArticle(esArticles[0], esArticles, ORIGIN, ctxPaired);
  assert.match(paired, new RegExp(`hreflang="en" href="${ORIGIN}/blog/${slug}"`), "pairs to English");
  assert.match(paired, new RegExp(`hreflang="es" href="${ORIGIN}/es/blog/${slug}"`), "and to Spanish");
  assert.match(paired, /hreflang="x-default" href="[^"]*\/blog\//, "x-default points at English");
});

test("English guides are unaffected: still English, still no alternates", () => {
  for (const a of enArticles) {
    const html = renderArticle(a, enArticles, ORIGIN, ctxEn);
    assert.match(html, /<html lang="en">/);
    // None of the live English guides has a Spanish counterpart, so still no hreflang.
    assert.doesNotMatch(html, /rel="alternate" hreflang/, `${a.slug}: no counterpart yet`);
    assert.ok(html.includes("All guides"), "English chrome intact");
  }
});
