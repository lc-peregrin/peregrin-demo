// Analytics tests.
//
// Two properties matter here. Nothing may be collected until credentials are
// supplied, because turning on visitor measurement is a data-collection
// decision and the privacy policy currently says nothing about analytics. And
// an analytics call must never be able to break the page: the site's one
// production outage was an assumed global throwing a ReferenceError, which is
// exactly the shape of a careless tracking call.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(join(__dirname, "..", "server.js"), "utf8");
const HTML = readFileSync(join(__dirname, "..", "public", "index.html"), "utf8");
const BLOG = readFileSync(join(__dirname, "..", "blog.js"), "utf8");

test("each provider is gated on its own credential and ships nothing without it", () => {
  assert.match(SERVER, /const PLAUSIBLE_DOMAIN = process\.env\.PLAUSIBLE_DOMAIN \|\| ""/);
  assert.match(SERVER, /const POSTHOG_KEY = process\.env\.POSTHOG_KEY \|\| ""/);
  // Empty credential must produce an empty tag, not a broken script.
  assert.match(SERVER, /const PLAUSIBLE_TAG = PLAUSIBLE_DOMAIN\s*\?[\s\S]{0,200}: "";/);
  assert.match(SERVER, /const POSTHOG_TAG = POSTHOG_KEY\s*\?[\s\S]{0,3000}: "";/);
  // No key may ever be hardcoded.
  assert.doesNotMatch(SERVER, /phc_[A-Za-z0-9]/, "no PostHog key may be committed");
});

test("PostHog is configured without cookies or session recording", () => {
  // localStorage persistence keeps returning-visitor attribution while writing
  // no cookie, so the site still needs no consent banner. Recording stays off.
  assert.match(SERVER, /persistence:"localStorage"/, "cookieless persistence, not the cookie default");
  assert.doesNotMatch(SERVER, /persistence:"cookie/, "must never opt into cookie persistence");
  assert.match(SERVER, /disable_session_recording:true/, "session recording must be off");
  assert.match(SERVER, /capture_pageview:true/, "automatic pageviews on");
  assert.match(SERVER, /capture_pageleave:true/, "pageleave capture on");
});

test("Vercel Web Analytics rides in the shared head tags", () => {
  assert.match(SERVER, /\/_vercel\/insights\/script\.js/, "the plain-site insights snippet");
  assert.match(SERVER, /VERCEL_INSIGHTS_TAG, ANALYTICS_SHIM\]/, "included in the shared tag list");
});

test("affiliate outbound clicks are captured with the destination domain", () => {
  const shim = SERVER.slice(SERVER.indexOf("const ANALYTICS_SHIM"), SERVER.indexOf("const ANALYTICS_TAG"));
  assert.match(shim, /affiliate_click/, "the affiliate_click event exists");
  for (const host of ["safetywing.com", "getyourguide.com", "airalo.com", "ektatraveling.com", "tp-em.com"]) {
    assert.ok(shim.includes(host), `listener must cover ${host}`);
  }
  assert.match(shim, /searchParams\.get\("u"\)/, "Drive links resolve to the real destination domain");
  assert.match(shim, /addEventListener\("click"[\s\S]*?, true\)/, "capture phase, so the event beats navigation");
});

test("checkout events emit the standard ecommerce names alongside ours", () => {
  const shim = SERVER.slice(SERVER.indexOf("const ANALYTICS_SHIM"), SERVER.indexOf("const ANALYTICS_TAG"));
  assert.match(shim, /checkout_started: "begin_checkout"/);
  assert.match(shim, /payment_completed: "purchase"/);
  // Both checkout paths fire checkout_started: the hold fee and the fare.
  assert.match(HTML, /track\("checkout_started", \{ purpose: "hold_fee" \}\)/);
  assert.match(HTML, /track\("checkout_started", \{ purpose: "fare" \}\)/);
});

test("Plausible is the cookieless site-wide pageview provider", () => {
  assert.match(SERVER, /plausible\.io\/js\/script\.js/);
  assert.match(SERVER, /data-domain="\$\{esc\(PLAUSIBLE_DOMAIN\)\}"/, "domain must be escaped");
  assert.match(SERVER, /<script defer /, "must not block rendering");
});

test("the tracking shim is vendor-neutral and can never throw", () => {
  const shim = SERVER.slice(SERVER.indexOf("const ANALYTICS_SHIM"), SERVER.indexOf("const ANALYTICS_TAG"));
  assert.match(shim, /window\.peregrinTrack = function/, "one entry point for all events");
  assert.match(shim, /try \{[\s\S]*catch/, "an analytics failure must not break the page");
  // Both providers are reached through the shim, so application code never
  // names a vendor.
  assert.match(shim, /window\.posthog/);
  assert.match(shim, /window\.plausible/);
});

test("the shim is always present, so an event call is a no-op rather than an error", () => {
  // ANALYTICS_TAG always includes the shim even when both providers are off.
  assert.match(SERVER, /const ANALYTICS_TAG = \[TRAVELPAYOUTS_TAG, PLAUSIBLE_TAG, POSTHOG_TAG, VERCEL_INSIGHTS_TAG, ANALYTICS_SHIM\]/);
  // And the homepage injection is unconditional: the analytics markup is passed
  // into every language render as headExtra, never conditionally.
  assert.match(SERVER, /headExtra: ANALYTICS_TAG/, "every homepage render must include the shim");
});

test("all six briefed events are wired to something real", () => {
  const events = {
    search_submitted: HTML,
    offer_selected: HTML,
    checkout_started: HTML,
    payment_completed: HTML,
    guide_read: BLOG,
    guide_to_product_click: BLOG,
  };
  for (const [name, src] of Object.entries(events)) {
    assert.ok(src.includes(`"${name}"`), `event ${name} is not wired`);
  }
});

test("application code never calls a vendor directly", () => {
  // Everything goes through the shim, so a provider can be swapped in one place.
  const appScript = HTML.slice(HTML.indexOf("<script>"), HTML.lastIndexOf("</script>"));
  assert.doesNotMatch(appScript, /posthog\.capture|plausible\(/, "call peregrinTrack instead");
});

test("guide_read fires at reading depth, not on page load", () => {
  // A bounce is not a read; firing on load would make the metric worthless.
  assert.match(BLOG, /depth >= 0\.5/, "must require real scroll depth");
  assert.match(BLOG, /if \(read\) return;/, "must fire at most once");
});

test("the Travelpayouts Drive tag ships unconditionally on every page", () => {
  // Travelpayouts' "Check Drive connection" probe fetches the live homepage and
  // looks for this tag, so unlike the analytics providers it must not be gated
  // on an environment variable.
  const tag = SERVER.slice(SERVER.indexOf("const TRAVELPAYOUTS_TAG"), SERVER.indexOf("const PLAUSIBLE_DOMAIN"));
  assert.match(tag, /tp-em\.com\/NTU1OTYx\.js\?t=555961/, "the exact marker URL");
  assert.match(tag, /script\.async = 1/, "must load async, never render-blocking");
  // The vendor's anti-optimiser attributes must survive verbatim.
  for (const attr of ['nowprocket', 'data-noptimize="1"', 'data-cfasync="false"',
    'data-wpfc-render="false"', 'seraph-accel-crit="1"', 'data-no-defer="1"']) {
    assert.ok(tag.includes(attr), `vendor attribute must be kept: ${attr}`);
  }
  // It reaches every page by riding the one head-tag list that all served
  // pages already include, and that list must not gate it behind a credential.
  assert.match(SERVER, /const ANALYTICS_TAG = \[TRAVELPAYOUTS_TAG, PLAUSIBLE_TAG/,
    "must be first in the shared head-tag list");
});
