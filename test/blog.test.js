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
import { listArticles, getArticle, renderBlogIndex, renderArticle, renderArticleBody, renderRecommendedBox,
  AFFILIATE_SLOTS, affiliateSlotLive } from "../blog.js";

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

// ---------------------------------------------------------------------------
// Images, authority links and affiliate structure
// ---------------------------------------------------------------------------

test("every article ships a hero image that actually exists on disk", () => {
  for (const a of articles) {
    assert.ok(a.hero, `${a.slug}: hero missing or its file is not on disk`);
    assert.ok(a.hero.startsWith("/content/blog/images/"), `${a.slug}: hero must live in the images folder`);
    const file = join(__dirname, "..", a.hero.replace(/^\//, ""));
    assert.ok(readFileSync(file).length > 1000, `${a.slug}: hero file must be a real image`);
    // Alt text is what a screen reader and a failed image both fall back to.
    assert.ok(a.heroAlt && a.heroAlt.length > 15, `${a.slug}: heroAlt must describe the picture`);
  }
});

test("the hero renders on the article and as the card image on the index", () => {
  const a = articles[0];
  const article = renderArticle(a, articles, ORIGIN);
  assert.match(article, /<figure class="hero-figure">/, "article needs a hero figure");
  assert.ok(article.includes(`src="${a.hero}"`), "hero src must come from front-matter");
  assert.ok(article.includes(`alt="${a.heroAlt.replace(/&/g, "&amp;")}"`), "hero needs its alt text");
  // The hero is the largest thing above the fold, so it is eager with priority
  // while every other image is lazy.
  assert.match(article, /fetchpriority="high"/, "hero should not be lazy-loaded");

  const index = renderBlogIndex(articles, ORIGIN);
  for (const art of articles) {
    assert.ok(index.includes(`src="${art.hero}"`), `${art.slug}: card image missing from the index`);
  }
  assert.match(index, /class="card-img"[^>]*loading="lazy"/, "card images must be lazy");
});

test("a post whose hero file is missing degrades instead of breaking", () => {
  // Simulates a post referencing an image nobody has added yet.
  const ghost = { ...articles[0], hero: "", heroAlt: "" };
  const html = renderArticle(ghost, articles, ORIGIN);
  // Checked as an element, not a class name: the stylesheet legitimately
  // mentions .hero-figure whether or not any post uses it.
  assert.doesNotMatch(html, /<figure class="hero-figure">/, "no empty figure when there is no hero");
  assert.doesNotMatch(html, /src=""/, "must never emit a broken image source");
});

test("inline markdown images render responsive, lazy and with alt text", () => {
  const out = renderArticleBody('![A queue at passport control](/content/blog/images/x.jpg "At the border")\n');
  assert.match(out, /<figure class="body-figure">/);
  assert.match(out, /loading="lazy"/, "inline images must be lazy");
  assert.match(out, /decoding="async"/);
  assert.match(out, /alt="A queue at passport control"/);
  assert.match(out, /<figcaption>At the border<\/figcaption>/, "the markdown title becomes a caption");
});

test("citations link to official sources and open safely in a new tab", () => {
  const schengen = getArticle("flight-reservation-schengen-visa");
  assert.ok(schengen, "the Schengen guide must resolve");
  const html = renderArticle(schengen, articles, ORIGIN);

  // Every quote that has a verified primary source in
  // automation/EMBASSY_QUOTES_VERIFIED.md must be linked to it.
  for (const host of ["singapur.diplo.de", "finlandabroad.fi", "usa.um.dk", "diplomatie.belgium.be"]) {
    assert.ok(html.includes(host), `missing the official source link for ${host}`);
  }
  // An external link without noopener hands the opened page a handle on ours.
  const externals = [...html.matchAll(/<a href="https?:\/\/(?!www\.peregrin\.travel)[^"]+"[^>]*>/g)].map((m) => m[0]);
  assert.ok(externals.length >= 4, "expected the outbound citations");
  for (const a of externals) {
    assert.match(a, /target="_blank"/, `external link should open in a new tab: ${a}`);
    assert.match(a, /rel="[^"]*noopener[^"]*noreferrer/, `unsafe external link: ${a}`);
  }
  // Internal links must not be given target/rel.
  assert.doesNotMatch(html, /<a href="\/blog"[^>]*target="_blank"/, "internal links stay in the tab");
});

test("posts carrying affiliate links show exactly one disclosure", () => {
  const affiliates = articles.filter((x) => x.hasAffiliate);
  assert.ok(affiliates.length, "the guides carry affiliate links");

  for (const a of affiliates) {
    const html = renderArticle(a, articles, ORIGIN);
    // A guide discloses either inline (preferred, sits right above the links) or
    // via the banner, never both: two disclosures on one page reads as clutter
    // and makes neither of them land.
    const inline = (html.match(/affiliate link/gi) || []).length;
    assert.ok(inline >= 1, `${a.slug}: no disclosure at all`);
    assert.equal((html.match(/class="affiliate-note"/g) || []).length,
      a.hasInlineDisclosure ? 0 : 1, `${a.slug}: disclosure must appear exactly once`);
    // Wording varies across guides; what matters is that the no-extra-cost point
    // is made, not the exact phrase.
    assert.match(html, /no extra cost|nothing extra|costs you nothing/i,
      `${a.slug}: disclosure must state there is no extra cost`);
  }

  // A post with an affiliate link but no inline disclosure still gets the banner.
  const banner = { ...articles[0], hasAffiliate: true, hasInlineDisclosure: false };
  assert.match(renderArticle(banner, articles, ORIGIN), /class="affiliate-note"/);
  // And a post with no affiliate link carries no banner it does not need.
  const clean = { ...articles[0], hasAffiliate: false, hasInlineDisclosure: false };
  assert.doesNotMatch(renderArticle(clean, articles, ORIGIN), /class="affiliate-note"/);
});

test("affiliate slots stay findable, and unfilled ones never become dead links", () => {
  // Every slot a guide references must exist in the map, or the link silently
  // renders as the raw token text.
  for (const a of articles) {
    for (const m of a.body.match(/\]\(([A-Z_]+)\)/g) || []) {
      const name = m.slice(2, -1);
      assert.ok(Object.prototype.hasOwnProperty.call(AFFILIATE_SLOTS, name),
        `${a.slug} references unknown slot ${name}`);
    }
  }
  // A pending slot renders as text, with no anchor and no visible token.
  const pending = renderArticleBody("Get an [Airalo](AIRALO_LINK) eSIM.\n");
  assert.doesNotMatch(pending, /<a /, "an unfilled slot must not become a link");
  assert.doesNotMatch(pending, /AIRALO_LINK/, "the token must never be shown to a reader");
  assert.match(pending, /Airalo/, "the label still reads normally");
  // A bare "#" behaves the same way, so the Booking placements stay safe.
  assert.doesNotMatch(renderArticleBody("Try [Booking.com](#).\n"), /<a /);

  // A live slot renders a sponsored, new-tab link.
  assert.ok(affiliateSlotLive("SAFETYWING_LINK"), "SafetyWing is approved and should be live");
  const live = renderArticleBody("Try [SafetyWing](SAFETYWING_LINK).\n");
  assert.match(live, /href="https:\/\/safetywing\.com/);
  assert.match(live, /rel="[^"]*sponsored/, "affiliate links must be marked sponsored");
});

test("SafetyWing links use the campaign URL, and the reward bonus is complete where present", () => {
  const swGuides = articles.filter((x) => x.body.includes("safetywing.com"));
  assert.ok(swGuides.length, "some guides link SafetyWing");
  for (const a of swGuides) {
    // Every SafetyWing link is the tracked campaign link, not a bare one.
    assert.ok(a.body.includes("safetywing.com/nomad-insurance?referenceID="),
      `${a.slug}: the campaign affiliate link must be used`);
    // Not every guide uses the reward-code offer; that is an editorial choice.
    // But where the PEREGRIN code appears, the full detail must appear with it,
    // so a half-written bonus never ships.
    if (a.body.includes("PEREGRIN")) {
      assert.ok(a.body.includes("enter code PEREGRIN"), `${a.slug}: bonus phrasing incomplete`);
      assert.ok(a.body.includes("8 weeks of electronics-theft cover free"), `${a.slug}: bonus detail missing`);
    }
  }
  // At least the original launch guides carry the full bonus, so the offer is live somewhere.
  assert.ok(swGuides.some((a) => a.body.includes("enter code PEREGRIN")), "the reward offer must appear on some guide");
});

test("the recommended box never ships a link that goes nowhere", () => {
  // A partner whose tracking URL is still the "#" placeholder renders as text.
  const pending = renderRecommendedBox({
    partner: "booking", title: "Somewhere for the first night",
    body: "Free cancellation while your plans firm up.", cta: "Find a stay",
  });
  assert.match(pending, /rec-box/, "the box should still render its copy");
  assert.doesNotMatch(pending, /<a /, "a placeholder URL must not become a link");
  assert.match(pending, /Link coming soon/);

  // A partner with a real URL renders a proper sponsored link.
  const live = renderRecommendedBox({
    partner: "safetywing", title: "Cover for a long trip",
    body: "Built for open-ended travel.", cta: "See SafetyWing",
  });
  assert.match(live, /<a class="rec-cta" href="https:\/\/safetywing\.com/);
  assert.match(live, /rel="noopener noreferrer sponsored"/, "affiliate links must be marked sponsored");
  assert.match(live, /target="_blank"/);

  // Unknown partners and half-filled specs render nothing at all.
  assert.equal(renderRecommendedBox({ partner: "nonesuch", title: "x", body: "y" }), "");
  assert.equal(renderRecommendedBox({ partner: "booking" }), "");
  assert.equal(renderRecommendedBox(null), "");
});

test("blog chrome carries no em dashes", () => {
  const html = renderArticle(articles[0], articles, ORIGIN);
  const chrome = html.slice(html.indexOf('class="cta-card"'));
  assert.doesNotMatch(chrome, /—/, "WRITING_STYLE.md: no em dashes");
  assert.doesNotMatch(renderBlogIndex(articles, ORIGIN).replace(/<article[\s\S]*/, ""), /—/);
});
