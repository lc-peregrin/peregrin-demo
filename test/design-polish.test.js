// Design-polish tests (conversion sections).
//
// Built from the Task B handoff and the live tokens rather than a .dc.html
// export, so these lock in the things the handoff was specific about: the CSS
// gap it flagged, the pillars reading differently from the personas, the sample
// modal degrading gracefully, and the reviews section never inventing content.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(__dirname, "..", "public", "index.html"), "utf8");

test("the flagged CSS gap is closed: .section-h / .section-sub are styled", () => {
  // Both were used in the markup with no rule anywhere, so they fell back to
  // browser defaults.
  assert.match(HTML, /^\s*\.section-h \{/m, ".section-h must have a rule");
  assert.match(HTML, /^\s*\.section-sub \{/m, ".section-sub must have a rule");
  // And they must still be used, otherwise the rules are dead.
  assert.ok(HTML.includes('class="section-h"'), ".section-h must be used in the markup");
  assert.ok(HTML.includes('class="section-sub"'), ".section-sub must be used in the markup");
});

test("trust pillars are icon-left rows, visually distinct from the persona grid", () => {
  assert.match(HTML, /\.trust-pillar \{[^}]*display: flex/, "pillars must be flex rows, not stacked cards");
  assert.match(HTML, /\.trust-grid \{[^}]*grid-template-columns: 1fr 1fr/,
    "pillars sit two-up, a different rhythm from the four-up persona grid");
  assert.match(HTML, /\.persona-grid \{[^}]*grid-template-columns: repeat\(4, 1fr\)/,
    "personas stay four-up so the two sections don't read the same");
  // One icon tile per pillar, and the copy/keys are unchanged.
  assert.equal((HTML.match(/class="trust-pillar-icon"/g) || []).length, 4, "one icon per pillar");
  for (const k of ["pillar_real", "pillar_verifiable", "pillar_fast", "pillar_secure"]) {
    assert.ok(HTML.includes(`data-i18n="${k}"`), `${k} must survive the rebuild`);
  }
  // The gold disclosure ribbon must be kept.
  assert.ok(HTML.includes('class="disclosure-ribbon"'), "gold disclosure ribbon must remain");
});

test("each persona card gained exactly one icon", () => {
  assert.equal((HTML.match(/class="persona-icon"/g) || []).length, 4, "one icon per persona card");
  assert.equal((HTML.match(/class="persona-card"/g) || []).length, 4, "still four persona cards");
});

test("the sample modal opens from the existing links and degrades gracefully", () => {
  assert.match(HTML, /id="sample-modal"/, "modal must exist");
  // Ships closed — .open is what reveals it.
  assert.doesNotMatch(HTML, /id="sample-modal"[^>]*class="[^"]*\bopen\b/, "modal must not ship open");
  assert.match(HTML, /\.modal-backdrop \{[^}]*display: none/, "backdrop hidden by default");
  // Both existing links are wired, and both keep a real href so the full page
  // still loads with JS off.
  for (const id of ["hero-sample-link", "tool-sample-link"]) {
    const anchor = (HTML.match(new RegExp(`<a[^>]*id="${id}"[^>]*>`)) || [])[0];
    assert.ok(anchor, `${id} must exist`);
    assert.match(anchor, /href="\/sample-reservation"/,
      `${id} must keep its real href as a no-JS fallback`);
  }
  assert.match(HTML, /\["hero-sample-link", "tool-sample-link"\]/, "both links must open the modal");
  // Dismissable by button, backdrop and Escape.
  assert.match(HTML, /id="sample-modal-close"/);
  assert.match(HTML, /e\.key === "Escape"/, "Escape must close the modal");
});

test("the sample document is watermarked and obviously an example", () => {
  // The sample-reservation modal is now the designed Sample Showcase: a
  // diagonal SAMPLE watermark on the .sm-doc specimen, with example carrier
  // (a real airline we return offers for) and traveller.
  assert.match(HTML, /\.sm-watermark span \{[^}]*transform: rotate\(-24deg\)/, "diagonal SAMPLE watermark required");
  assert.ok(HTML.includes('<span>SAMPLE</span>'), "the watermark text is SAMPLE");
  assert.match(HTML, /rgba\(28,111,140,\.06\)/, "watermark stays low-opacity, using the accent token colour");
  assert.ok(HTML.includes("Thai Airways"), "specimen carrier must be a real airline we return offers for");
  assert.ok(HTML.includes("A. Sample Traveller"), "passenger must read as an example");
});

test("reviews section invents nothing and stays hidden while empty", () => {
  // The component and its placement exist, but the source is empty and the
  // section is only revealed when it has real entries.
  assert.match(HTML, /const TESTIMONIALS = \[\];/, "review source must ship empty — no invented quotes");
  assert.match(HTML, /if \(!TESTIMONIALS\.length\) return;/, "must bail out while empty");
  assert.match(HTML, /id="testimonials" style="display:none;"/, "section ships hidden");
  // No star ratings anywhere in the component (recency-led by design).
  const block = HTML.slice(HTML.indexOf('id="testimonials"'), HTML.indexOf("</section>", HTML.indexOf('id="testimonials"')));
  assert.doesNotMatch(block, /★|⭐|[0-9]\.[0-9]\s*\/\s*5|out of 5/i, "no ratings may be implied");
});

test("polish added no new brand colours", () => {
  // Everything must come from the existing token set; a stray hex would mean a
  // colour was invented rather than reused.
  const allowed = new Set([
    "#16283a", "#5c6b7c", "#e2e7ec", "#f8f9fb", "#1c6f8c", "#e8f2f5", "#124a5e",
    "#c9922e", "#faf1e0", "#1f7a5c", "#e7f4ee", "#fff", "#ffffff",
    // pre-existing accents already in the file before this pass
    "#cfe4ea", "#ecd9ad", "#c3e2d1", "#cfe3ea", "#c3d7f2", "#eaf1fb", "#fdf1ef",
    "#f3c9c0", "#8a3a2c", "#d68b7c", "#c2503a", "#fbe7e2", "#fdf7f6", "#6d4d12",
    "#7a5a1d", "#14543d", "#1f6b4f", "#c3cad3", "#dbecf1", "#f4fafb", "#2b3b4c",
    "#c3d0da", "#a15b1f", "#fbeee7", "#d8dee5", "#bcd9e2", "#2a5fa5", "#c3e2d1",
    "#fafbfc",
    // Trust Band design handoff (2026-07-28): band border + verify-arrow grey,
    // designer-supplied in Peregrin Trust Band.dc.html.
    "#d5e6ec", "#b6c4ce",
    // Sample Showcase handoff (2026-07-28): gold-marker ink and dark-CTA hover,
    // from Peregrin Sample Showcase.dc.html.
    "#241a06", "#0e1c2b",
  ].map((c) => c.toLowerCase()));
  const styles = HTML.slice(HTML.indexOf("<style>"), HTML.indexOf("</style>"));
  const hexes = [...new Set((styles.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((h) => h.toLowerCase()))];
  const unexpected = hexes.filter((h) => !allowed.has(h));
  assert.deepEqual(unexpected, [], `unexpected colours introduced: ${unexpected.join(", ")}`);
});
