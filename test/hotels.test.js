// /hotels: affiliate free-cancellation hotels. Peregrin never holds a room.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { renderHotelsPage, HOTELS_PATHS, HOTELS_COPY, TRIP_CITIES, tripHotelUrl, TRIP_HOTELS_HOME } from "../hotels.js";

const SERVER = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const HTML = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const ORIGIN = "https://www.peregrin.travel";

test("four language routes, each self-canonical with a full hreflang cluster", () => {
  assert.deepEqual(Object.keys(HOTELS_PATHS), ["en", "es", "ru", "hi"]);
  for (const [lang, p] of Object.entries(HOTELS_PATHS)) {
    const html = renderHotelsPage({ lang, origin: ORIGIN });
    assert.match(html, new RegExp(`<html lang="${lang}">`));
    assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN}${p}">`), `${lang} canonical`);
    for (const [l, q] of Object.entries(HOTELS_PATHS)) {
      assert.ok(html.includes(`hreflang="${l}" href="${ORIGIN}${q}"`), `${lang} page lists ${l} alternate`);
    }
    assert.ok(html.includes(`hreflang="x-default" href="${ORIGIN}/hotels"`));
    assert.ok(html.includes(`<title>${HOTELS_COPY[lang].title.replace(/&/g, "&amp;")}</title>`));
  }
  const titles = new Set(Object.values(HOTELS_COPY).map((c) => c.title));
  assert.equal(titles.size, 4, "titles are unique per language");
});

test("copy follows the house rules: no em dashes, no hold/fake/dummy", () => {
  for (const [lang, c] of Object.entries(HOTELS_COPY)) {
    const text = JSON.stringify(c);
    assert.ok(!text.includes("—"), `${lang}: no em dashes`);
    if (lang === "en") assert.doesNotMatch(text, /\b(hold|holds|held|fake|dummy)\b/i);
  }
  const html = renderHotelsPage({ lang: "en", origin: ORIGIN });
  assert.ok(!html.includes("—"), "rendered page has no em dashes");
  assert.ok(html.includes(HOTELS_COPY.en.disclosure), "affiliate disclosure is shown");
});

test("partner links are plain trip.com URLs with no affiliate parameters", () => {
  const url = tripHotelUrl({ cityId: 1231, checkin: "2026-12-10", checkout: "2026-12-13", guests: 2 });
  assert.equal(url, "https://www.trip.com/hotels/list?cityId=1231&checkin=2026-12-10&checkout=2026-12-13&adult=2&crn=1");
  assert.equal(tripHotelUrl({ cityId: "" }), TRIP_HOTELS_HOME);
  const html = renderHotelsPage({ lang: "en", origin: ORIGIN });
  assert.doesNotMatch(html, /agoda|booking\.com|marker=|allianceid|sid=/i);
  assert.ok(TRIP_CITIES.every((c) => Number.isInteger(c.id) && c.name.en && c.name.es && c.name.ru && c.name.hi));
});

test("hotel search fires its analytics event and trip.com counts as an affiliate click", () => {
  const html = renderHotelsPage({ lang: "es", origin: ORIGIN });
  assert.match(html, /peregrinTrack\("hotel_search_submitted"/);
  assert.match(html, /language: LANG/);
  const shim = SERVER.slice(SERVER.indexOf("const ANALYTICS_SHIM"), SERVER.indexOf("const ANALYTICS_TAG"));
  assert.ok(shim.includes('"trip.com"'), "affiliate listener covers trip.com");
  assert.match(shim, /partner: dest/);
});

test("routes and sitemap cover all four languages; the Duffel Stays API is gone", () => {
  assert.match(SERVER, /for \(const \[lang, route\] of Object\.entries\(HOTELS_PATHS\)\)/);
  assert.match(SERVER, /Object\.values\(HOTELS_PATHS\)\.map\(\(p\) => \(\{ loc: `\$\{SITE_ORIGIN\}\$\{p\}`/);
  assert.doesNotMatch(SERVER, /\/api\/stays|\/stays\/search|stays\/bookings/);
  assert.doesNotMatch(HTML, /stays-flow|\/api\/stays|ENABLE_ACCOMMODATION/);
  assert.match(HTML, /id="tab-hotels" href="\/hotels"/, "homepage links to /hotels");
});
