// /sample-reservation tests.
//
// This page is a sales tool: it shows the real document's layout so a visitor
// can judge the quality before paying. That makes two things safety-critical.
// It must be unmistakably a specimen, because a clean copy of a realistic
// itinerary is exactly what a forger would want. And it must stay static, since
// a Duffel call here would spend a real offer request on every crawler hit.
//
// Asserted against the server source rather than over HTTP, matching the other
// server-page tests, so the suite needs no port and no API keys.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(join(__dirname, "..", "server.js"), "utf8");

// The route body: from its handler to the next top-level section comment.
const ROUTE = SERVER.slice(
  SERVER.indexOf('app.get("/sample-reservation"'),
  SERVER.indexOf("// ---------- Programmatic SEO landing pages ----------")
);
const SAMPLE_BLOCK = SERVER.slice(SERVER.indexOf("const SAMPLE = {"), SERVER.indexOf('app.get("/sample-reservation"'));

test("the route exists and serves a page rather than a redirect or 404", () => {
  assert.ok(ROUTE.length > 500, "route must render a full page");
  assert.match(ROUTE, /res\.type\("html"\)\.send\(/, "must send HTML");
  assert.doesNotMatch(ROUTE, /status\(404\)|redirect\(/, "the sample must always resolve");
});

test("the document is watermarked across its whole area, not stamped once", () => {
  // A single centred stamp can be cropped out of a screenshot; a tiled overlay
  // cannot.
  const marks = (ROUTE.match(/SAMPLE SAMPLE SAMPLE/g) || []).length;
  assert.ok(marks >= 6, `watermark must repeat down the page, found ${marks} rows`);
  assert.match(ROUTE, /class="wm"/, "watermark overlay element required");
  assert.match(ROUTE, /rotate\(-24deg\)/, "watermark sits on the diagonal");
  assert.match(ROUTE, /pointer-events:none/, "watermark must not intercept clicks");
  // It is decoration, so it must not be announced to screen readers.
  assert.match(ROUTE, /class="wm" aria-hidden="true"/, "watermark must be aria-hidden");
});

test("every identifying field reads as an obvious specimen", () => {
  assert.match(SAMPLE_BLOCK, /pnr: "SAMPLE"/, "booking reference must be a placeholder");
  assert.match(SAMPLE_BLOCK, /passenger: "SAMPLE TRAVELLER"/, "passenger must be a placeholder");
  assert.match(ROUTE, /Example only\./, "the page must say plainly that it is an example");
  assert.match(ROUTE, /not a real airline record/, "must state the reference is not real");
});

test("the page is static: no Duffel call, no offer request, no live fetch", () => {
  const live = /duffel\(|offer_request|DUFFEL_API_KEY|await fetch\(/;
  assert.doesNotMatch(ROUTE, live, "the sample must never hit the airline API");
  assert.doesNotMatch(SAMPLE_BLOCK, live, "sample data must be static");
  // The example carrier logo is bundled rather than fetched at request time.
  assert.match(ROUTE, /\/img\/sample-carrier-logo\.svg/, "logo must be served locally");
});

test("it is indexable and targets the sample-reservation keyword", () => {
  // Deliberately indexable (Liam's call): the page targets "sample flight
  // reservation for visa", so it must not carry noindex and must be self-
  // canonical. The SAMPLE watermark and the "example only" copy keep it from
  // being mistaken for a real reservation even when indexed.
  assert.doesNotMatch(ROUTE, /content="noindex"/, "must be indexable");
  assert.match(ROUTE, /rel="canonical" href="[^"]*\/sample-reservation"/, "self-canonical");
  const server = readFileSync(join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /SITE_ORIGIN\}\/sample-reservation`, priority/, "must be in the sitemap");
});

test("the example itinerary carries the same real-document detail", () => {
  // Flight number, aircraft and cabin are what make the layout read as genuine
  // quality, which is the entire point of showing it.
  assert.match(SAMPLE_BLOCK, /flight: "SQ\d+"/, "flight numbers required");
  assert.match(SAMPLE_BLOCK, /aircraft: "[^"]+"/, "aircraft type required");
  assert.match(SAMPLE_BLOCK, /cabin: "[^"]+"/, "cabin class required");
  assert.match(SAMPLE_BLOCK, /label: "Outbound"/, "a round trip shows the return too");
  assert.match(SAMPLE_BLOCK, /label: "Return"/);
});

test("fine print is simplified but keeps the legal noun rules", () => {
  const fine = ROUTE.slice(ROUTE.indexOf('class="fine"'), ROUTE.indexOf("</div>", ROUTE.indexOf('class="fine"')));
  assert.match(fine, /held reservation, not a purchased ticket/i, "the held-vs-ticketed line must stay");
  assert.match(fine, /Verification:/, "the verify concept must stay");
  // The long advisories belong on the real document, not the specimen.
  assert.doesNotMatch(fine, /Data protection|passport and any required visas|Entry requirements/i,
    "the sample drops the long footnotes");
  assert.ok((fine.match(/<p>/g) || []).length <= 3, "fine print stays short");
});

test("the call to action names the page as an example and links to the tool", () => {
  const cta = ROUTE.slice(ROUTE.indexOf('class="cta"'));
  assert.match(cta, /This is an example\. Get your real reservation in minutes\./);
  assert.match(cta, /href="\/#search"/, "CTA must lead to the search tool");
});

test("no em dashes in the sample page copy", () => {
  assert.doesNotMatch(ROUTE, /—/, "WRITING_STYLE.md: no em dashes");
  assert.doesNotMatch(SAMPLE_BLOCK, /—/, "WRITING_STYLE.md: no em dashes");
});
