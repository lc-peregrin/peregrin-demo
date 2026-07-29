// Guide search tests.
//
// The search is a client-side filter over an embedded registry of published
// guides. The properties that matter: the registry contains exactly the page's
// own language section (a Spanish page must never offer an English URL and can
// never surface an unpublished guide), the box appears in the header and at the
// top of the index, the strings exist for all four site languages, and the
// script is inline with no external dependency.

import { test } from "node:test";
import assert from "node:assert/strict";
import { listArticles, renderBlogIndex, renderArticle, buildBlogCtx, guideSlugs } from "../blog.js";

const ORIGIN = "https://www.peregrin.travel";
const en = listArticles("en");
const es = listArticles("es");
const ctxEn = buildBlogCtx("en", { enSlugs: guideSlugs("en"), esSlugs: guideSlugs("es"), origin: ORIGIN });
const ctxEs = buildBlogCtx("es", { enSlugs: guideSlugs("en"), esSlugs: guideSlugs("es"), origin: ORIGIN });

const registryOf = (html) => {
  const m = html.match(/<script type="application\/json" id="guide-registry">(.*?)<\/script>/s);
  assert.ok(m, "registry JSON must be embedded");
  return JSON.parse(m[1]);
};

test("the index embeds a registry of its own published guides plus the visa hub", () => {
  const html = renderBlogIndex(en, ORIGIN, ctxEn);
  const reg = registryOf(html);
  assert.equal(reg.length, en.length + 1, "every published guide plus the hub entry");
  for (const r of reg) {
    assert.ok(r.t && r.u.startsWith("/blog/"), "entries carry a title and a /blog URL");
  }
  const slugs = new Set(en.map((a) => a.slug));
  const guides = reg.filter((r) => r.u !== "/blog/visa-requirements-by-country");
  assert.equal(guides.length, en.length);
  for (const r of guides) assert.ok(slugs.has(r.u.replace("/blog/", "")), `registry URL must be a published guide: ${r.u}`);
  assert.ok(reg.some((r) => r.u === "/blog/visa-requirements-by-country"), "the hub is searchable");
});

test("a Spanish page's registry is Spanish-only", () => {
  const html = renderArticle(es[0], es, ORIGIN, ctxEs);
  const reg = registryOf(html);
  assert.equal(reg.length, es.length);
  for (const r of reg) assert.match(r.u, /^\/es\/blog\//, "no English URL may leak into the Spanish registry");
});

test("the box renders in the header and at the top of the index, localised", () => {
  const enHtml = renderBlogIndex(en, ORIGIN, ctxEn);
  assert.match(enHtml, /guide-search header-search/, "header box");
  assert.match(enHtml, /guide-search index-search/, "index-top box");
  assert.match(enHtml, /Search a country or guide/, "English placeholder");
  const esHtml = renderBlogIndex(es, ORIGIN, ctxEs);
  assert.match(esHtml, /Busca un país o una guía/, "Spanish placeholder");
  // Article pages get the header box (no card list to filter).
  const article = renderArticle(en[0], en, ORIGIN, ctxEn);
  assert.match(article, /guide-search header-search/, "header box on guides too");
});

test("all four site languages have search strings, matching the i18n convention", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../blog.js", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("const SEARCH_I18N"), src.indexOf("const SEARCH_CSS"));
  for (const lang of ["en:", "es:", "ru:", "hi:"]) {
    assert.ok(block.includes(lang), `search strings must exist for ${lang.replace(":", "")}`);
  }
});

test("the search is self-contained: inline script, no external source", () => {
  const html = renderBlogIndex(en, ORIGIN, ctxEn);
  const scripts = [...html.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
  for (const attrs of scripts) {
    // The only external script allowed in the head is whatever headExtra
    // injects (analytics/affiliate, set by the server); the search itself must
    // not add one. In this render, headExtra is empty, so nothing may have src.
    assert.doesNotMatch(attrs, /\bsrc=/, "search must not load an external script");
  }
});

test("matching is diacritic-insensitive in the shipped matcher", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../blog.js", import.meta.url), "utf8");
  const script = src.slice(src.indexOf("const SEARCH_SCRIPT"), src.indexOf("function searchSpec"));
  assert.match(script, /normalize\("NFD"\)/, "must strip diacritics so 'Mexico' finds 'México'");
  assert.match(script, /toLowerCase\(\)/, "must be case-insensitive");
});
