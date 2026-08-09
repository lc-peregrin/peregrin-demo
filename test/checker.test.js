// Onward-ticket checker tests.
//
// The checker's one promise: it must never be more optimistic than the guide
// it links to. These tests pin the data invariants (every destination is a
// real hub destination with a live guide or anchor, tiers reference known
// passports, exactly one fallback tier) and the five spot-check combinations
// from the 9 Aug brief, whose verdicts must match the linked guides' text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { listArticles, PASSPORTS, HUB_META, HUB_NO_GUIDE, BADGE_LEGEND } from "../blog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = JSON.parse(readFileSync(join(__dirname, "..", "data", "checker.json"), "utf8"));
const CODES = new Set(PASSPORTS.map(([c]) => c));
const slugs = new Set(listArticles("en").map((a) => a.slug));

test("every destination is real: a published guide or a hub anchor row", () => {
  assert.equal(DATA.destinations.length, 34, "the 34 hub destinations (five more arrive with the pending guides batch; see _todo)");
  for (const d of DATA.destinations) {
    const hasGuide = slugs.has(d.slug);
    const isAnchor = HUB_NO_GUIDE.some((r) => r.name === d.name);
    assert.ok(hasGuide || isAnchor, `${d.slug}: must map to a guide or a hub anchor`);
    assert.ok(["checkin", "immigration", "visa"].includes(d.badge), `${d.slug}: bad badge`);
    assert.ok(["high", "medium", "low"].includes(d.enforcement), `${d.slug}: bad enforcement`);
  }
  assert.ok(DATA._todo.includes("New Zealand") && DATA._todo.includes("onward-ticket-uk"),
    "the pending five-guides batch is recorded as a TODO");
});

test("tiers reference known passports and exactly one tier is the fallback", () => {
  for (const d of DATA.destinations) {
    const lists = [d.tiers.visaFree, d.tiers.visaOnArrival, d.tiers.visaRequired];
    let defaults = 0;
    for (const list of lists) {
      for (const code of list) {
        if (code === "default") { defaults++; continue; }
        assert.ok(CODES.has(code), `${d.slug}: unknown passport code ${code}`);
      }
    }
    assert.equal(defaults, 1, `${d.slug}: exactly one tier must be the fallback`);
    // Every tier with members needs a note to show.
    for (const [tier, list] of Object.entries(d.tiers)) {
      if (list.length && !(list.length === 1 && list[0] === "default" && tier !== "visaRequired")) {
        if (list.length) assert.ok(d.tierNotes[tier] || list.every((c) => c === "default" && d.tierNotes[tier]),
          `${d.slug}: tier ${tier} has members but no note`);
      }
    }
    // A passport can only sit in one explicit tier.
    const seen = new Map();
    for (const [tier, list] of Object.entries(d.tiers)) {
      for (const code of list) {
        if (code === "default") continue;
        assert.ok(!seen.has(code), `${d.slug}: ${code} is in both ${seen.get(code)} and ${tier}`);
        seen.set(code, tier);
      }
    }
  }
});

// The verdict function, mirrored from the page script; the spot checks below
// assert the outcomes the guides describe.
function verdictFor(d) {
  if (d.badge === "visa") return "visa-application";
  if (d.enforcement === "low") return "uncommon";
  return d.badge === "checkin" ? (d.enforcement === "high" ? "yes-checkin" : "likely-checkin")
    : (d.enforcement === "high" ? "yes-immigration" : "likely-immigration");
}
function tierOf(d, code) {
  const t = d.tiers;
  if (t.visaFree.includes(code)) return "visaFree";
  if (t.visaOnArrival.includes(code)) return "visaOnArrival";
  if (t.visaRequired.includes(code)) return "visaRequired";
  if (t.visaFree.includes("default")) return "visaFree";
  if (t.visaOnArrival.includes("default")) return "visaOnArrival";
  return "visaRequired";
}
const bySlug = Object.fromEntries(DATA.destinations.map((d) => [d.slug, d]));

test("spot checks: five briefed combinations match their guides", () => {
  // Thailand + US: guide says visa-exempt 60 days, airlines check at check-in.
  let d = bySlug["proof-of-onward-travel-thailand"];
  assert.equal(tierOf(d, "US"), "visaFree");
  assert.equal(verdictFor(d), "yes-checkin");
  assert.match(d.tierNotes.visaFree, /60 days/);

  // Philippines + IN: guide's visa-free list is broad but India is not stated
  // in it, so India must NOT get the optimistic tier; enforcement is firm.
  d = bySlug["onward-ticket-philippines"];
  assert.equal(tierOf(d, "IN"), "visaRequired", "India defaults rather than guessing generously");
  assert.equal(verdictFor(d), "yes-checkin");

  // Costa Rica + DE: guide names "most of the EU" as visa-exempt with the
  // formal proof-of-exit requirement.
  d = bySlug["proof-of-onward-travel-costa-rica"];
  assert.equal(tierOf(d, "DE"), "visaFree");
  assert.match(d.tierNotes.visaFree, /formal entry requirement/);

  // Brazil + GB: UK stays visa-free (the e-visa change hit US/CA/AU, not GB).
  d = bySlug["proof-of-onward-travel-brazil"];
  assert.equal(tierOf(d, "GB"), "visaFree");
  assert.equal(tierOf(d, "US"), "visaRequired", "US needs Brazil's e-visa; must not be optimistic");

  // Cambodia + AU: guide describes VoA/e-visa for most non-ASEAN passports.
  d = bySlug["proof-of-onward-travel-cambodia"];
  assert.equal(tierOf(d, "AU"), "visaOnArrival");
  assert.equal(verdictFor(d), "visa-application");
});

test("the legend and badges share one vocabulary", () => {
  const labels = new Set(Object.keys(BADGE_LEGEND));
  assert.deepEqual([...labels].sort(), ["Check-in", "Immigration", "Visa application"]);
  for (const slug of Object.keys(HUB_META)) {
    assert.ok(labels.has(HUB_META[slug].where), `${slug}: hub badge outside the fixed vocabulary`);
  }
});
