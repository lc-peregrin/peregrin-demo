// Contextual affiliate links in the guides (pass of 22 Nov 2026).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIRS = ["content/blog", "content/blog-es"];
const BRANDS = { safetywing: /safetywing\.com/, getyourguide: /getyourguide\.com/, airalo: /airalo\.com/, klook: /klook\.com/,
  saily: /saily\.com|SAILY_LINK/, yesim: /yesim\.app/, welcomepickups: /welcomepickups\.com/, localrent: /localrent\.com/, tiqets: /tiqets\.com/ };
const guides = DIRS.flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith(".md")).map((f) => ({ d, f, s: fs.readFileSync(path.join(ROOT, d, f), "utf8") })));

test("no guide carries more than 3 affiliate brands", () => {
  for (const g of guides) {
    const n = Object.values(BRANDS).filter((re) => re.test(g.s)).length;
    assert.ok(n <= 3, `${g.d}/${g.f} has ${n} affiliate brands`);
  }
});

test("guides never link unconnected or rejected brands, or Aviasales", () => {
  for (const g of guides) {
    assert.doesNotMatch(g.s, /\]\([^)]*(agoda|booking\.com|trip\.com|ektatraveling|aviasales)[^)]*\)|EKTA_LINK|AGODA_LINK|\]\(#\)/i, `${g.d}/${g.f}`);
  }
});

test("hotel mentions point at Peregrin's own /hotels page, in the guide's language", () => {
  const en = guides.filter((g) => g.d === "content/blog" && /\]\(\/hotels\)/.test(g.s));
  const es = guides.filter((g) => g.d === "content/blog-es" && /\]\(\/es\/hotels\)/.test(g.s));
  assert.ok(en.length >= 30 && es.length >= 10);
  for (const g of guides.filter((x) => x.d === "content/blog-es")) assert.doesNotMatch(g.s, /\]\(\/hotels\)/, `${g.f} should use /es/hotels`);
});
