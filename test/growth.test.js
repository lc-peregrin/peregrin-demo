// Launch waitlist, llms.txt and homepage Product data (22 Nov 2026).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { cleanSignup, unsubToken, WAITLIST_EMAIL } from "../launch-waitlist.js";

const HTML = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const WL = fs.readFileSync(new URL("../public/waitlist.js", import.meta.url), "utf8");
const LLMS = fs.readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8");

test("waitlist input is validated and cleaned server-side", () => {
  const s = cleanSignup({ email: " a@b.co ", travel_date: "2026-12-01", route: "BKK → SIN<script>", source: "checkout", lang: "ru" });
  assert.ok(s.ok); assert.equal(s.email, "a@b.co"); assert.ok(!s.route.includes("<"), "no markup in route"); assert.equal(s.lang, "ru");
  assert.ok(!cleanSignup({ email: "nope" }).ok);
  assert.equal(cleanSignup({ email: "a@b.co", travel_date: "soon" }).travel_date, "");
  assert.ok(cleanSignup({ email: "a@b.co", website: "spam" }).bot, "honeypot flags bots");
});

test("unsubscribe links are signed per email", () => {
  assert.equal(unsubToken("A@b.co", "k"), unsubToken("a@b.co", "k"));
  assert.notEqual(unsubToken("a@b.co", "k"), unsubToken("c@b.co", "k"));
});

test("waitlist copy: four languages, consent line, never claims holds are available, no em dashes", () => {
  for (const l of ["en", "es", "ru", "hi"]) { assert.ok(WAITLIST_EMAIL[l].subject); assert.ok(WL.includes(`${l}: {`)); }
  assert.ok(WL.includes("We'll only email you about Peregrin's launch. Unsubscribe any time."));
  assert.ok(WL.includes("Reservations are paused while we add a new airline partner."));
  assert.ok(!WL.includes("—") && !JSON.stringify(WAITLIST_EMAIL).includes("—"));
  assert.match(WL, /track\("waitlist_signup", \{ source: source, route: route \|\| null, language: L/);
  assert.doesNotMatch(WL, /localStorage\.setItem/, "nothing stored in the browser");
});

test("waitlist appears on the homepage, in checkout, and on the sample page", () => {
  assert.match(HTML, /data-waitlist="homepage"/);
  assert.match(HTML, /first\.type === "hold_unavailable" && window\.PeregrinWaitlist/);
  const SERVER = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(SERVER, /data-waitlist="sample-reservation"/);
});

test("homepage carries Organization and Product structured data", () => {
  const types = [...HTML.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])["@type"]);
  assert.ok(types.includes("Organization") && types.includes("Product"));
});

test("llms.txt is honest about the pause and links the key pages", () => {
  assert.match(LLMS, /paused while Peregrin adds a new airline partner/);
  assert.match(LLMS, /US\$14\.99/);
  assert.match(LLMS, /is-a-flight-reservation-for-a-visa-legal/);
  assert.ok(!LLMS.includes("—"));
});
