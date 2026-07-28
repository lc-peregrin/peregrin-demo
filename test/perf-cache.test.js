// Performance-caching tests.
//
// The live homepage TTFB regressed to ~2s once the guide count grew, because
// every request re-read and re-parsed every markdown file, and every cold start
// loaded ~15MB of Stripe and pdfkit modules that only the payment and PDF routes
// need. These tests pin the fixes so the regression cannot silently return.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { listArticles } from "../blog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(join(__dirname, "..", "server.js"), "utf8");

test("guides are parsed once and reused, not re-parsed per call", () => {
  const first = listArticles("en");
  const second = listArticles("en");
  // Identity, not just deep equality: a fresh parse would return a new array.
  assert.strictEqual(first, second, "same reference means the cache served it");
  assert.strictEqual(listArticles("es"), listArticles("es"), "es cached too");
});

test("listArticles does not read a markdown file on a cache hit", () => {
  // Warm the cache, then count file reads on the next call. It should stat the
  // directory to check freshness but never readFile a guide.
  listArticles("en");
  const realRead = fs.readFileSync;
  let mdReads = 0;
  fs.readFileSync = (p, ...rest) => {
    if (String(p).endsWith(".md")) mdReads++;
    return realRead(p, ...rest);
  };
  try {
    listArticles("en");
  } finally {
    fs.readFileSync = realRead;
  }
  assert.equal(mdReads, 0, "a cache hit must not read any markdown file");
});

test("the heavy payment and PDF modules are not imported at the top level", () => {
  // They must be lazy so a homepage cold start does not pay to load them.
  assert.doesNotMatch(SERVER, /^import .*["']stripe["']/m, "Stripe must be lazy-loaded");
  assert.doesNotMatch(SERVER, /^import .*["']pdfkit["']/m, "pdfkit must be lazy-loaded");
  assert.doesNotMatch(SERVER, /^import .*["']svg-to-pdfkit["']/m, "svg-to-pdfkit must be lazy-loaded");
  assert.doesNotMatch(SERVER, /^import .*["']qrcode["']/m, "qrcode must be lazy-loaded");
  // And they are reachable through the lazy getters instead.
  assert.match(SERVER, /async function getStripe\(\)/);
  assert.match(SERVER, /async function getPdfDeps\(\)/);
  assert.match(SERVER, /import\("stripe"\)/);
  assert.match(SERVER, /import\("pdfkit"\)/);
});

test("content responses are CDN-cacheable, and API responses are not", () => {
  assert.match(SERVER, /Cache-Control", CONTENT_CACHE_CONTROL/, "content routes set a cache header");
  assert.match(SERVER, /s-maxage=600/, "must set an edge cache window");
  assert.match(SERVER, /stale-while-revalidate/, "must allow stale-while-revalidate");
  // The middleware must exclude /api so orders, checkout, search and the webhook
  // are never cached.
  assert.match(SERVER, /!req\.path\.startsWith\("\/api\/"\)/, "must not cache /api");
});

test("the blog and language pages are served from a rendered-HTML cache", () => {
  assert.match(SERVER, /const _pageCache = new Map\(\)/);
  assert.match(SERVER, /cachedPage\("\/blog"/);
  assert.match(SERVER, /cachedPage\(`\/blog\/\$\{slug\}`/);
  assert.match(SERVER, /cachedPage\("\/es\/blog"/);
  assert.match(SERVER, /cachedPage\("\/faq"/);
});
