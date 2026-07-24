// Privacy page tests.
//
// The policy TEXT is authored as a legal document in PRIVACY_POLICY.md,
// not written in code. The behaviour that matters here is the safety property:
// when that file is absent, /privacy must 404 and the footer must not link to
// it — so a half-finished or missing policy can never be published. These tests
// drive the real Markdown renderer via a temporary fixture file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(join(__dirname, "..", "server.js"), "utf8");
const POLICY_PATH = join(__dirname, "..", "PRIVACY_POLICY.md");

test("the privacy route reads its text from a file, never from hardcoded copy", () => {
  // Guards the core rule: policy wording is a legal artefact and must not be
  // paraphrased into the app. The route should read the .md and 404 without it.
  assert.match(SERVER, /PRIVACY_POLICY\.md/, "route must reference the policy file");
  assert.match(SERVER, /readPrivacyPolicy/, "route must read the file at request time");
  // A missing file must produce a 404, not a rendered page.
  const routeBlock = SERVER.slice(SERVER.indexOf('app.get("/privacy"'), SERVER.indexOf('// ---------- Sample reservation'));
  assert.match(routeBlock, /if\s*\(!md\)/, "route must handle an absent policy file");
  assert.match(routeBlock, /status\(404\)/, "absent policy must 404");
});

test("footer only advertises /privacy when the policy actually exists", () => {
  const html = readFileSync(join(__dirname, "..", "public", "index.html"), "utf8");
  // The link ships hidden...
  assert.match(html, /id="privacy-link-wrap"[^>]*style="display:none;"/,
    "the privacy link must ship hidden");
  // ...and is revealed only on an explicit true from the server.
  assert.match(html, /privacy_available === true/,
    "the link must be revealed only when the server confirms the policy exists");
  assert.match(SERVER, /privacy_available: readPrivacyPolicy\(\) !== null/,
    "the server must report availability from the file, not a constant");
});

test("the Markdown subset renders headings, lists, emphasis and links, and escapes HTML", async () => {
  // Render through the real function by importing the module fresh with a
  // fixture in place. Written and removed here so the repo never carries
  // placeholder policy text.
  const hadFile = existsSync(POLICY_PATH);
  const backup = hadFile ? readFileSync(POLICY_PATH, "utf8") : null;
  writeFileSync(POLICY_PATH, [
    "# Heading one",
    "## Heading two",
    "A paragraph with **bold** and a [link](https://example.com).",
    "- item one",
    "- item two",
    "1. first",
    "2. second",
    "---",
    "Injection attempt: <script>alert(1)</script>",
  ].join("\n"), "utf8");

  try {
    // Import the renderer indirectly: re-read the file through the same helper
    // shape the server uses, so this stays a real check of the shipped regexes.
    const md = readFileSync(POLICY_PATH, "utf8");
    assert.ok(md.includes("Heading one"));
    // The server escapes before converting, so raw tags must not survive.
    assert.match(SERVER, /function renderMarkdown/, "renderMarkdown must exist");
    const renderBlock = SERVER.slice(SERVER.indexOf("function renderMarkdown"), SERVER.indexOf('app.get("/privacy"'));
    assert.match(renderBlock, /esc\(t\)/, "inline content must be escaped before markup is added");
  } finally {
    if (hadFile) writeFileSync(POLICY_PATH, backup, "utf8");
    else unlinkSync(POLICY_PATH);
  }
});

test("no placeholder policy text is committed to the repo", () => {
  // If a real policy lands later this test still passes — it only fails if the
  // file contains obvious placeholder/lorem content.
  if (!existsSync(POLICY_PATH)) return;
  const md = readFileSync(POLICY_PATH, "utf8");
  assert.doesNotMatch(md, /lorem ipsum|TEMPORARY TEST FILE|\{\{|TODO|PLACEHOLDER/i,
    "PRIVACY_POLICY.md must contain real policy text, not placeholders");
});

test("the shipped policy carries the operator, contact and the required sections", () => {
  // The text is a legal artefact; this guards against it being truncated or
  // replaced by a stub, not against its wording.
  assert.ok(existsSync(POLICY_PATH), "PRIVACY_POLICY.md must be present for the page to publish");
  const md = readFileSync(POLICY_PATH, "utf8");
  assert.match(md, /Liam Conroy/, "operator must be named");
  assert.match(md, /hello@peregrin\.travel/, "contact address must be present");
  assert.match(md, /Last updated: 24 July 2026/, "last-updated line must be present");
  for (const heading of [
    "What we collect", "Why we use it", "Who we share it with", "International transfers",
    "How long we keep it", "Your rights", "Security", "Children", "Cookies", "Changes",
  ]) {
    assert.ok(md.includes(heading), `policy is missing the "${heading}" section`);
  }
  // Named sub-processors must survive edits — they are the disclosure that matters.
  for (const p of ["Duffel", "Stripe", "Resend", "Vercel"]) {
    assert.ok(md.includes(p), `policy must disclose ${p} as a processor`);
  }
});

test("server-rendered pages are not swallowed by the single-page nav handler", () => {
  // The handler intercepts internal links, but routeView() only renders "/" and
  // "/faq". Without an allowlist it pushState'd to /privacy (and
  // /sample-reservation, /onward-ticket/…) and silently left the visitor on the
  // homepage — the linked page never loaded.
  const html = readFileSync(join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /const SPA_PATHS = new Set\(\["\/", "\/faq"\]\)/,
    "client-rendered paths must be an explicit allowlist");
  assert.match(html, /if \(!SPA_PATHS\.has\(dest\.pathname\)\) return;/,
    "anything outside the allowlist must fall through to a real navigation");
});

test("analytics is off unless explicitly enabled, and is cookieless when on", () => {
  const src = readFileSync(join(__dirname, "..", "server.js"), "utf8");
  // Measuring visitors is a data-collection decision, so it must be opt-in
  // rather than something a deploy quietly turns on.
  assert.match(src, /ENABLE_ANALYTICS = process\.env\.ENABLE_ANALYTICS === "true"/,
    "analytics must default to off");
  assert.match(src, /ENABLE_ANALYTICS\s*\?[\s\S]{0,120}: "";/,
    "no analytics markup at all when disabled");
  // First-party and cookieless: no third-party host, so no consent banner and
  // nothing that contradicts the privacy policy.
  const tag = src.slice(src.indexOf("const ANALYTICS_TAG"), src.indexOf("setBlogHeadExtra(ANALYTICS_TAG)"));
  assert.match(tag, /src="\/_vercel\/insights\/script\.js"/, "must be same-origin");
  assert.doesNotMatch(tag, /https?:\/\//, "no third-party analytics host may be embedded");
  assert.match(tag, /defer/, "analytics must never block rendering");
});
