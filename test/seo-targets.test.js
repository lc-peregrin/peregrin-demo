// On-page SEO target tests.
//
// Two jobs. First, the targets transcribed into seo-targets.js must obey the
// rules SEO_TARGET_MAP.md sets for itself, so a bad transcription or a later
// edit fails here rather than in Search Console weeks later.
//
// Second, and more important: the map deliberately prescribes internal links to
// guides that do not exist yet. Rendering those would put links to 404s on live
// pages, which is worse than no link. These tests pin the rule that a mapped
// link only renders once its target exists, and that it switches itself on when
// the guide is published.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SEO_TARGETS, seoTargetFor, liveLinks, liveRoutes, linkLabel } from "../seo-targets.js";
import { listArticles, renderArticle, renderBlogIndex } from "../blog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "https://www.peregrin.travel";
const articles = listArticles();
const slugs = articles.map((a) => a.slug);

// Mirrors blog.js esc(), so expectations compare against what is really emitted
// (apostrophes and ampersands are entity-encoded in attributes).
const esc = (v) => String(v).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

test("every target obeys the map's own length rules", () => {
  for (const [route, t] of Object.entries(SEO_TARGETS)) {
    if (t.title) assert.ok(t.title.length < 60, `${route}: title is ${t.title.length} chars, must be < 60`);
    if (t.meta) assert.ok(t.meta.length < 155, `${route}: meta is ${t.meta.length} chars, must be < 155`);
    assert.ok(t.h1 && t.h1.length > 5, `${route}: needs an H1`);
  }
});

test("targets follow the voice rules", () => {
  for (const [route, t] of Object.entries(SEO_TARGETS)) {
    const copy = [t.title, t.meta, t.h1].filter(Boolean).join(" ");
    assert.doesNotMatch(copy, /—/, `${route}: no em dashes in page copy`);
    // "fake" is only ever allowed when warning against faked documents, and no
    // target does that, so it must not appear at all.
    assert.doesNotMatch(copy, /\bfake\b/i, `${route}: never use the word fake`);
    // "ticket" is allowed only in "ticket reservation", "e-ticket", "dummy
    // ticket" (a search term we target) and "onward ticket" (the same).
    for (const m of copy.match(/\w+[-\s]ticket|ticket[-\s]\w+/gi) || []) {
      assert.match(m, /ticket reservation|e-ticket|dummy ticket|onward ticket|ticket at|ticket you|ticket first|ticket before|ticket\b/i,
        `${route}: unexpected use of "ticket": ${m}`);
    }
  }
});

test("the three corrected metas are the ones in use", () => {
  assert.ok(SEO_TARGETS["/blog/dummy-ticket-visa-application"].meta.endsWith("without buying one."));
  assert.ok(SEO_TARGETS["/blog/proof-of-onward-travel-japan"].meta.endsWith("Here's how to be ready."));
  assert.ok(SEO_TARGETS["/blog/proof-of-onward-travel-costa-rica"].meta.endsWith("without buying a ticket."));
});

// ---------------------------------------------------------------------------
// Self-activating internal links
// ---------------------------------------------------------------------------

test("a mapped link to a guide that does not exist is not rendered", () => {
  // Thailand is told to link to Vietnam and the dummy-ticket pillar, neither of
  // which is published. Neither may appear.
  const links = liveLinks("/blog/proof-of-onward-travel-thailand", slugs);
  assert.ok(!links.includes("/blog/proof-of-onward-travel-vietnam"), "unpublished guide must not be linked");
  assert.ok(!links.includes("/blog/dummy-ticket-visa-application"), "unpublished pillar must not be linked");
  // The one that does exist is linked.
  assert.ok(links.includes("/blog/onward-ticket-philippines"), "a published guide must be linked");
});

test("a mapped link switches itself on when its guide is published", () => {
  const route = "/blog/proof-of-onward-travel-thailand";
  const before = liveLinks(route, slugs);
  assert.ok(!before.includes("/blog/proof-of-onward-travel-vietnam"));

  // Simulate the overnight writer publishing the Vietnam guide. Nothing else
  // changes: no code edit, no manual wiring.
  const after = liveLinks(route, [...slugs, "proof-of-onward-travel-vietnam"]);
  assert.ok(after.includes("/blog/proof-of-onward-travel-vietnam"),
    "publishing the guide must activate the link by itself");
});

test("no rendered page links to a route that does not exist", () => {
  const live = liveRoutes(slugs);
  const pages = [renderBlogIndex(articles, ORIGIN), ...articles.map((a) => renderArticle(a, articles, ORIGIN))];
  for (const html of pages) {
    for (const m of html.matchAll(/href="(\/[^"#?]*)"/g)) {
      const href = m[1].replace(/\/$/, "") || "/";
      // Assets and API paths are not pages.
      if (href.startsWith("/content/") || href.startsWith("/api/") || href.startsWith("/fonts/")) continue;
      if (/\.(png|jpg|svg|ico|xml|txt|webmanifest)$/.test(href)) continue;
      assert.ok(live.has(href), `rendered a link to a page that does not exist: ${href}`);
    }
  }
});

test("a page never renders an empty read-next box", () => {
  // Privacy has no mapped links at all; nothing should be emitted for it.
  assert.deepEqual(liveLinks("/privacy", slugs), []);
  // And a route with only unpublished targets renders nothing rather than an
  // empty heading.
  const html = renderArticle(articles.find((a) => a.slug === "flight-reservation-schengen-visa"), articles, ORIGIN);
  if (!liveLinks("/blog/flight-reservation-schengen-visa", slugs).length) {
    assert.doesNotMatch(html, /class="read-next"/, "no empty read-next box");
  }
});

test("a link never points at the page it is on", () => {
  for (const route of Object.keys(SEO_TARGETS)) {
    assert.ok(!liveLinks(route, slugs).includes(route), `${route} links to itself`);
  }
});

// ---------------------------------------------------------------------------
// Applied to the live pages
// ---------------------------------------------------------------------------

test("live guides render the mapped title, meta and H1", () => {
  for (const a of articles) {
    const t = seoTargetFor(`/blog/${a.slug}`);
    if (!t) continue;
    const html = renderArticle(a, articles, ORIGIN);
    assert.equal(html.match(/<title>(.*?)<\/title>/)[1], esc(t.title), `${a.slug}: title must come from the map`);
    assert.ok(html.includes(`content="${esc(t.meta)}"`), `${a.slug}: meta must come from the map`);
    assert.ok(html.includes(`<h1 class="page">${esc(t.h1)}</h1>`), `${a.slug}: H1 must come from the map`);
  }
});

test("the homepage has exactly one H1 and the mapped one", () => {
  const html = readFileSync(join(__dirname, "..", "public", "index.html"), "utf8");
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, "exactly one H1 in the source");
  assert.ok(html.includes(SEO_TARGETS["/"].h1), "the H1 must be the mapped one");
  assert.ok(html.includes(`<title>${SEO_TARGETS["/"].title.replace("&", "&amp;")}</title>`), "mapped title");
  // Organization + WebSite, per the map.
  assert.match(html, /"@type": "Organization"/);
  assert.match(html, /"@type": "WebSite"/);
});

test("guides with an FAQ section emit FAQPage schema that matches the page", () => {
  const withFaq = articles.filter((a) => /^##\s+FAQ\s*$/mi.test(a.body));
  assert.ok(withFaq.length, "the guides have FAQ sections");
  for (const a of withFaq) {
    const html = renderArticle(a, articles, ORIGIN);
    const ld = [...html.matchAll(/application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]));
    const faq = ld.find((l) => l["@type"] === "FAQPage");
    assert.ok(faq, `${a.slug}: FAQPage schema required`);
    assert.ok(faq.mainEntity.length >= 2, `${a.slug}: FAQ schema looks empty`);
    for (const q of faq.mainEntity) {
      assert.ok(q.name && q.acceptedAnswer.text, `${a.slug}: question and answer both required`);
      // Marking up a question that is not on the page is a structured-data
      // violation, so every question must appear in the body.
      assert.ok(a.body.includes(q.name), `${a.slug}: FAQ schema question is not on the page: ${q.name}`);
    }
  }
});

test("a guide without an FAQ emits no FAQPage schema", () => {
  const html = renderArticle({ ...articles[0], body: "## Something\n\nJust prose.\n" }, articles, ORIGIN);
  const ld = [...html.matchAll(/application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]));
  assert.ok(!ld.some((l) => l["@type"] === "FAQPage"), "must not emit empty FAQ schema");
});

test("guide og:image uses the guide's own hero", () => {
  const a = articles[0];
  const html = renderArticle(a, articles, ORIGIN);
  assert.ok(html.includes(`<meta property="og:image" content="${ORIGIN}${a.hero}">`), "og:image must be the hero");
  assert.ok(html.includes(`<meta name="twitter:image" content="${ORIGIN}${a.hero}">`), "twitter:image must be the hero");
});

test("link labels are readable, never bare URLs", () => {
  for (const route of ["/blog", "/", "/sample-reservation"]) {
    for (const l of liveLinks(route, slugs)) {
      const label = linkLabel(l, articles);
      assert.ok(label && !label.startsWith("/"), `${l}: needs a human label, got ${label}`);
    }
  }
});
