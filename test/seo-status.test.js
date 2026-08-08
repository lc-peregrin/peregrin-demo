// /seo-status.json tests.
//
// The endpoint exists so external monitors can check SEO health without
// crawling, which only works if its numbers are true. The core property: the
// reported sitemap_url_count must equal the number of <url> entries the real
// /sitemap.xml emits. Both come from the same sitemapUrls() list in server.js;
// this test boots the actual server and compares the two live responses, so a
// future refactor that forks the sources fails here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3891;

async function withServer(fn) {
  const child = spawn(process.execPath, [join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  try {
    // Wait for the server to accept connections.
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try {
        await fetch(`http://localhost:${PORT}/seo-status.json`);
        up = true;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    assert.ok(up, "server did not start");
    await fn();
  } finally {
    child.kill();
  }
}

test("seo-status.json matches the real sitemap and serves no-store", async () => {
  await withServer(async () => {
    const statusRes = await fetch(`http://localhost:${PORT}/seo-status.json`);
    assert.equal(statusRes.headers.get("cache-control"), "no-store",
      "monitors must always see the current deploy, never an edge copy");
    const status = await statusRes.json();

    const xml = await (await fetch(`http://localhost:${PORT}/sitemap.xml`)).text();
    const urlCount = (xml.match(/<url>/g) || []).length;
    assert.equal(status.sitemap_url_count, urlCount,
      "the reported count must equal the <url> entries actually emitted");

    // Every promised field is present and truthful in shape.
    for (const key of ["generated_at", "sitemap_url_count", "published_en_guides",
      "published_es_guides", "comparison_pages", "visa_hub_live",
      "robots_allows_crawl", "sitemap_referenced_in_robots", "last_deploy"]) {
      assert.ok(key in status, `missing field: ${key}`);
    }
    assert.ok(status.published_en_guides >= 42, "the 30 Jul batch puts EN at 42+");
    assert.equal(status.comparison_pages, 2);
    assert.equal(status.visa_hub_live, true);
    assert.equal(status.robots_allows_crawl, true);
    assert.equal(status.sitemap_referenced_in_robots, true);
    // Guide URLs must genuinely be inside the sitemap the count describes.
    assert.ok(xml.includes("/blog/proof-of-onward-travel-argentina"), "new guides are in the sitemap");
    assert.ok(xml.includes("/es/blog/"), "language URLs are in the sitemap");
  });
});

test("the Nomad Pass page is in the sitemap the status endpoint counts", async () => {
  await withServer(async () => {
    const xml = await (await fetch(`http://localhost:${PORT}/sitemap.xml`)).text();
    assert.ok(xml.includes("/nomad-pass"), "the waitlist page must be crawlable via the sitemap");
    const page = await fetch(`http://localhost:${PORT}/nomad-pass`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes("One subscription. Every border run covered."), "the H1 renders");
    assert.ok(html.includes('"@type":"FAQPage"'), "FAQ JSON-LD is served");
    // The waitlist endpoint validates email and rate-limits.
    const bad = await fetch(`http://localhost:${PORT}/api/nomad-pass-waitlist`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", monthly_usage: "1" }),
    });
    assert.equal(bad.status, 400, "invalid email is rejected");
    const ok = await fetch(`http://localhost:${PORT}/api/nomad-pass-waitlist`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "probe@example.com", monthly_usage: "2-3" }),
    });
    assert.equal(ok.status, 200, "valid signup is accepted (no POSTHOG_KEY locally: logged)");
  });
});
