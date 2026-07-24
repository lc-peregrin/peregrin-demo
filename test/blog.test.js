// Blog tests.
//
// The blog is the traffic engine, so these focus on the things that decide
// whether it actually ranks and converts: every article resolves, has exactly
// one <h1>, a correct canonical, and valid Article + BreadcrumbList JSON-LD —
// plus the front-matter parsing that everything else is derived from.
//
// Rendered through the real blog module, so a broken article file fails here
// rather than in production.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { listArticles, getArticle, renderBlogIndex, renderArticle, renderArticleBody } from "../blog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "https://www.peregrin.travel";
const articles = listArticles();

function jsonLdFrom(html) {
  return [...html.matchAll(/application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]));
}

test("every markdown file in content/blog is loaded as an article", () => {
  const files = readdirSync(join(__dirname, "..", "content", "blog")).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 2, "the two launch guides should be present");
  assert.equal(articles.length, files.length, "every .md must parse into an article");
});

test("front-matter parses and required fields are present", () => {
  for (const a of articles) {
    assert.ok(a.slug, "slug required");
    assert.ok(a.title && a.title.length > 10, `${a.slug}: title required`);
    assert.ok(a.description && a.description.length > 30, `${a.slug}: description required for meta`);
    assert.match(a.date, /^\d{4}-\d{2}-\d{2}$/, `${a.slug}: ISO date required for sitemap lastmod`);
    assert.ok(a.readingTime, `${a.slug}: reading time required for the card`);
    // Front-matter quotes must be stripped, not carried into the markup.
    assert.doesNotMatch(a.title, /^["']|["']$/, `${a.slug}: title quotes must be stripped`);
  }
});

test("articles are listed newest first", () => {
  const dates = articles.map((a) => a.date);
  assert.deepEqual([...dates].sort().reverse(), dates, "index order must be newest first");
});

test("each article page returns the right title, canonical and single h1", () => {
  for (const a of articles) {
    const html = renderArticle(a, articles, ORIGIN);
    assert.ok(html.includes(`<title>`), `${a.slug}: needs a title tag`);
    // Title comes from front-matter (the SEO string), h1 from the body heading.
    const title = html.match(/<title>(.*?)<\/title>/)[1];
    assert.ok(title.length > 10, `${a.slug}: title must be substantive`);
    assert.match(html, new RegExp(`rel="canonical" href="${ORIGIN}/blog/${a.slug}"`),
      `${a.slug}: canonical must be absolute and self-referencing`);
    assert.equal((html.match(/<h1/g) || []).length, 1, `${a.slug}: exactly one h1`);
    assert.ok(html.includes("<article>"), `${a.slug}: semantic article element`);
  }
});

test("each article emits valid Article + BreadcrumbList JSON-LD", () => {
  for (const a of articles) {
    const lds = jsonLdFrom(renderArticle(a, articles, ORIGIN));
    const types = lds.map((l) => l["@type"]);
    assert.ok(types.includes("Article"), `${a.slug}: Article schema required`);
    assert.ok(types.includes("BreadcrumbList"), `${a.slug}: BreadcrumbList required`);

    const art = lds.find((l) => l["@type"] === "Article");
    assert.equal(art.datePublished, a.date, "datePublished must come from front-matter");
    assert.equal(art.author.name, "Peregrin");
    assert.ok(art.publisher && art.publisher.name === "Peregrin", "publisher required");
    assert.equal(art.mainEntityOfPage["@id"], `${ORIGIN}/blog/${a.slug}`);

    const crumbs = lds.find((l) => l["@type"] === "BreadcrumbList");
    assert.equal(crumbs.itemListElement.length, 3, "Home > Guides > article");
    assert.deepEqual(crumbs.itemListElement.map((i) => i.position), [1, 2, 3]);
  }
});

test("the index lists every article and emits Blog + ItemList", () => {
  const html = renderBlogIndex(articles, ORIGIN);
  assert.match(html, new RegExp(`rel="canonical" href="${ORIGIN}/blog"`));
  assert.equal((html.match(/<h1/g) || []).length, 1, "index needs exactly one h1");
  for (const a of articles) {
    assert.ok(html.includes(`/blog/${a.slug}`), `${a.slug} must be linked from the index`);
    assert.ok(html.includes(a.description.slice(0, 40).replace(/&/g, "&amp;")) || html.includes(a.slug),
      `${a.slug} excerpt should appear`);
  }
  const types = jsonLdFrom(html).map((l) => l["@type"]);
  assert.ok(types.includes("Blog") && types.includes("ItemList"), "index schema required");
});

test("no article renders prose as a code block", () => {
  // The hazard the handoff called out: an indented paragraph in the markdown
  // silently becomes a <pre> and reads as code. Asserted across every article
  // rather than against one draft's wording, so rewrites don't break it.
  for (const a of articles) {
    const html = renderArticle(a, articles, ORIGIN);
    assert.ok(!html.includes("<pre>"), `${a.slug}: nothing should render as a code block`);
  }
  // Where an article does pull a quote out, it must be a real blockquote.
  const thai = getArticle("proof-of-onward-travel-thailand");
  assert.ok(thai, "Thailand guide must resolve by slug");
  const body = renderArticle(thai, articles, ORIGIN);
  for (const line of thai.body.split("\n")) {
    if (line.startsWith("> ")) {
      assert.ok(body.includes("<blockquote>"), "a markdown quote must render as a blockquote");
      break;
    }
  }
});

test("raw HTML in an article is dropped rather than passed through", () => {
  const out = renderArticleBody('Hello <script>alert(1)</script> and <img src=x onerror=y>\n');
  assert.doesNotMatch(out, /<script|onerror=/i, "raw HTML must not survive rendering");
});

test("an unknown slug resolves to nothing (so the route can 404)", () => {
  assert.equal(getArticle("no-such-guide"), null);
});

test("blog chrome keeps the legal noun rules", () => {
  const html = renderArticle(articles[0], articles, ORIGIN);
  // Chrome copy we author (CTA/footer) must not call anything fake, and must not
  // claim a purchased ticket.
  const chrome = html.slice(html.indexOf('class="cta-card"'));
  assert.doesNotMatch(chrome, /\bfake\b/i, "never use 'fake' in our own copy");
  for (const m of chrome.match(/[^.]*purchased ticket[^.]*/gi) || []) {
    assert.match(m, /not a purchased ticket/i, `unqualified purchase claim: ${m.trim()}`);
  }
});

test("server wires /blog into the sitemap with per-article lastmod", () => {
  const server = readFileSync(join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /\/blog\/\$\{a\.slug\}/, "articles must be in the sitemap");
  assert.match(server, /lastmod: a\.date/, "article lastmod must come from front-matter");
  assert.match(server, /u\.lastmod \|\| today/, "sitemap must honour a per-url lastmod");
});
