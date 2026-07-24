// Booking-flow safety tests for public/index.html
//
// WHY THIS EXISTS
// ---------------
// The frontend is a single, no-build-step file (public/index.html) with all of
// its JavaScript inline in one <script> block. There is no bundler, linter, or
// type-checker in the pipeline, so a reference to something that isn't actually
// in scope ships silently: it throws a ReferenceError only when that code path
// runs in a real browser. A real production incident of exactly this kind
// happened — `translations[lang]` was referenced in three places assuming a
// global `lang` that never existed (it's only ever a parameter of
// `applyLang(lang)`), which broke the confirmation screen for every successful
// hold until it was caught by hand.
//
// WHAT THIS HARNESS CHECKS (on every `npm test` run)
// --------------------------------------------------
//   1. The inline <script> block extracted from index.html parses without
//      syntax errors (`new vm.Script(...)`).
//   2. The whole script loads and runs inside a *minimal* stub DOM that exposes
//      ONLY the browser globals the code legitimately uses. Because reading an
//      undeclared identifier throws a ReferenceError in JS, any "assumed global"
//      (like the original `lang` bug) throws the moment its code path executes —
//      turning a silent production break into a failed test.
//   3. renderOrder() is exercised with representative mock orders across all 4
//      languages (en/es/ru/hi), in both the "held / awaiting payment" and
//      "ticketed" states, asserting no throw and that the key confirmation
//      elements (booking-ref, stripe-pay-btn, confirmation-title) get populated.
//   4. The other two code paths that referenced the same bad global — the Stripe
//      "Pay with card" click handler and the on-load handleStripeReturn() — are
//      driven directly so their assumed-global-sensitive lines actually execute.
//
// The used-but-declared guard is deliberately DYNAMIC, not a text search: the
// correct code inside applyLang() legitimately reads translations[lang] (there
// `lang` is a real parameter in scope), so a blunt grep can't tell that apart
// from the bug, where the same expression sat in a function with no `lang` in
// scope. Running the code in the minimal sandbox can tell them apart — an
// out-of-scope `lang` throws ReferenceError the moment its path executes.
//
// No browser, no jsdom, no framework, no build step — just node:test + node:vm
// and a hand-rolled DOM stub, so it runs anywhere Node runs with zero installs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, "..", "public", "index.html");
const html = readFileSync(HTML_PATH, "utf8");

const LANGS = ["en", "es", "ru", "hi"];

// ---- extract the inline application <script> (NOT the ld+json one) -----------
// The ld+json block is <script type="application/ld+json">; the app block is a
// bare <script>. Matching the bare opening tag selects only the app script.
function extractInlineScript(source) {
  const m = source.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("Could not find the inline <script> block in index.html");
  return m[1];
}

// ---- discover ids and data-i18n keys from the real markup -------------------
// Parsed from the HTML *before* the app script so template-literal markup inside
// the JS isn't misread as real elements. Keeps the stub DOM in sync with the
// actual page without hardcoding element lists here.
function parseMarkup(source) {
  const beforeScript = source.slice(0, source.indexOf("<script>"));
  const tagRe = /<([a-zA-Z][\w-]*)\b([^>]*?)\/?>/g;
  const els = [];
  let m;
  while ((m = tagRe.exec(beforeScript))) {
    const attrs = m[2];
    const idM = attrs.match(/\bid="([^"]+)"/);
    const i18nM = attrs.match(/\bdata-i18n="([^"]+)"/);
    const valM = attrs.match(/\bvalue="([^"]*)"/);
    // Inline display so elements that ship hidden (e.g. the test-mode badge)
    // start hidden in the stub too, the same as the real page.
    const styleM = attrs.match(/\bstyle="([^"]*)"/);
    const dispM = styleM && styleM[1].match(/display\s*:\s*([^;]+)/);
    if (idM || i18nM) els.push({
      id: idM ? idM[1] : null,
      i18n: i18nM ? i18nM[1] : null,
      value: valM ? valM[1] : null,
      display: dispM ? dispM[1].trim() : null,
    });
  }
  return els;
}

const inlineScript = extractInlineScript(html);
const markup = parseMarkup(html);

// ---- minimal DOM element stub ------------------------------------------------
function makeEl(id, tag) {
  const classes = new Set();
  const el = {
    id: id || null,
    tagName: (tag || "div").toUpperCase(),
    _text: "",
    _html: "",
    _i18n: null,
    _attrs: {},
    value: "",
    disabled: false,
    dataset: {},
    children: [],
    parentElement: null,
    style: { display: "", setProperty() {} },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        on ? classes.add(c) : classes.delete(c);
        return on;
      },
    },
    get className() { return [...classes].join(" "); },
    // Real DOM allows many listeners per event, and the app relies on that
    // (e.g. both applyLang and the search widgets listen to lang-select's
    // "change"). Storing a single handler would silently drop one of them.
    _handlers: {},
    addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
    getAttribute(name) { return name === "data-i18n" ? this._i18n : (this._attrs[name] ?? null); },
    setAttribute(name, v) { this._attrs[name] = String(v); },
    closest() { return null; },
    focus() {},
    appendChild(child) { child.parentElement = this; this.children.push(child); },
    // Descendant search supporting the simple selectors this app uses
    // (".class" and bare tag names).
    matches(sel) {
      if (!sel) return false;
      return sel.startsWith(".") ? classes.has(sel.slice(1)) : this.tagName === sel.toUpperCase();
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => n.children.forEach((c) => { if (c.matches(sel)) out.push(c); walk(c); });
      walk(this);
      return out;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    get innerHTML() { return this._html; },
    // Parsing assigned HTML into real child stubs is what lets tests exercise
    // dynamically-rendered markup (the traveller-details inputs) — the exact
    // place the blank-family_name bug lived.
    set innerHTML(v) { this._html = String(v); this.children = parseHtmlToEls(String(v), this); },
  };
  return el;
}

// Deliberately small HTML parser: enough for the app's generated markup
// (nested divs/inputs/labels with class, data-*, value and type attributes).
function parseHtmlToEls(htmlStr, parent) {
  const tagRe = /<(\/)?([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/)?>/g;
  const roots = [];
  const stack = [];
  let m;
  while ((m = tagRe.exec(htmlStr))) {
    const [, closing, tagName, attrStr, selfClose] = m;
    if (closing) { stack.pop(); continue; }
    const el = makeEl(null, tagName);
    for (const a of attrStr.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
      const [, name, val = ""] = a;
      if (!name) continue;
      if (name === "class") val.split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
      else if (name === "value") el.value = val;
      else if (name === "data-i18n") el._i18n = val;
      else if (name.startsWith("data-")) el.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = val;
      else if (name === "id") el.id = val;
      else el._attrs[name] = val;
    }
    const p = stack[stack.length - 1];
    if (p) { el.parentElement = p; p.children.push(el); } else { el.parentElement = parent; roots.push(el); }
    const isVoid = /^(input|br|img|hr|meta|link)$/i.test(tagName);
    if (!selfClose && !isVoid) stack.push(el);
  }
  return roots;
}

// ---- load the app into a fresh minimal environment --------------------------
// Returns handles for driving/asserting. Any read of an identifier that isn't a
// standard JS built-in or one of the browser globals seeded below will throw a
// ReferenceError while the script runs — which is exactly the bug class we guard.
function loadApp({ lang = "en", locationSearch = "", fetchImpl } = {}) {
  // Default input values declared in the markup (value="..."), so the stub
  // reflects the same starting state the real page loads with.
  const idValues = {};
  const idDisplay = {};
  markup.forEach((e) => {
    if (e.id && e.value != null) idValues[e.id] = e.value;
    if (e.id && e.display != null) idDisplay[e.id] = e.display;
  });

  const registry = new Map();
  const getEl = (id) => {
    if (!registry.has(id)) {
      const el = makeEl(id);
      if (idValues[id] != null) el.value = idValues[id];
      if (idDisplay[id] != null) el.style.display = idDisplay[id];
      registry.set(id, el);
    }
    return registry.get(id);
  };

  // data-i18n elements, sharing the same stub instance when they also have an id
  const dataI18nEls = markup
    .filter((e) => e.i18n)
    .map((e) => {
      const el = e.id ? getEl(e.id) : makeEl();
      el._i18n = e.i18n;
      return el;
    });

  const store = new Map();
  if (lang) store.set("peregrin_lang", lang);
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  let hrefValue = "";
  const location = {
    search: locationSearch,
    pathname: "/",
    get href() { return hrefValue; },
    set href(v) { hrefValue = v; },
  };

  const documentElement = makeEl("__html__");
  const documentHandlers = {};
  const document = {
    getElementById: (id) => getEl(id),
    querySelectorAll: (sel) => (sel === "[data-i18n]" ? dataI18nEls : []),
    querySelector: () => makeEl(),
    createElement: () => makeEl(),
    // The popover widgets close themselves via a document-level click listener.
    addEventListener(ev, fn) { (documentHandlers[ev] = documentHandlers[ev] || []).push(fn); },
    documentElement,
  };

  // window.addEventListener is used for the popstate (back/forward) nav handler.
  const window = { open() {}, location, addEventListener() {}, removeEventListener() {}, scrollTo() {} };

  const defaultFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  let currentFetch = fetchImpl || defaultFetch;

  const sandbox = {
    document,
    window,
    location,
    history: { replaceState() {}, pushState() {} },
    navigator: {},
    localStorage,
    console,
    alert: () => {},
    // Mutable so a test can swap the implementation after load (e.g. to capture
    // the /api/hold body once the form is filled).
    fetch: (...a) => currentFetch(...a),
    URLSearchParams, // Node's global, matches browser semantics
    // timers are no-ops so real intervals/timeouts never keep the process alive
    // and the 1s countdown loop doesn't spin during tests
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };

  const context = vm.createContext(sandbox);

  // Expose the internal functions/state so tests can drive them directly.
  const exposeSrc = `
    ;globalThis.__app = {
      renderOrder, applyLang, startCountdown, show, switchTab, translations,
      setCurrentOrder(o) { currentOrder = o; },
      getCurrentOrder() { return currentOrder; },
      setSelectedOffer(o) { selectedOffer = o; },
      setSelectedRate(r) { selectedRate = r; },
      renderPaxDetails,
      setSearchedPax(p) { searchedPax = p; },
    };`;

  vm.runInContext(inlineScript + exposeSrc, context, { filename: "index.html:inline-script" });

  return {
    app: sandbox.__app,
    el: getEl,
    location,
    // Fire every captured handler for an event, e.g. trigger("stripe-pay-btn", "click").
    // Returns a promise so async handlers can be awaited.
    trigger: (id, ev, arg) => Promise.all((getEl(id)._handlers[ev] || []).map((fn) => fn(arg))),
    setFetch: (fn) => { currentFetch = fn; },
  };
}

// representative mock orders (shape mirrors what /api/hold and /api/order return)
const heldOrder = () => ({
  order_id: "ord_test123",
  booking_reference: "ABC123",
  route_summary: "BKK → SIN",
  airline: "Singapore Airlines",
  flight_number: "SQ973",
  awaiting_payment: true,
  payment_required_by: new Date(Date.now() + 3600 * 1000).toISOString(),
});

const ticketedOrder = () => ({
  order_id: "ord_test456",
  booking_reference: "XYZ789",
  route_summary: "BKK → SIN",
  airline: "Singapore Airlines",
  flight_number: "SQ973",
  awaiting_payment: false,
});

// =============================================================================
// 1. Static checks
// =============================================================================

test("inline <script> block parses without syntax errors", () => {
  assert.doesNotThrow(
    () => new vm.Script(inlineScript, { filename: "index.html:inline-script" }),
    "The inline application script in public/index.html has a syntax error",
  );
});

// =============================================================================
// 2. Load in a minimal sandbox — any assumed-global throws here
// =============================================================================

test("app loads and runs top-level code without throwing (no assumed globals at load)", () => {
  assert.doesNotThrow(() => loadApp({ lang: "en" }));
});

test("handleStripeReturn() on-load path runs without throwing (assumed-global site #3)", () => {
  // Loading with ?paid_order_id synchronously runs handleStripeReturn's body,
  // including the `translations[...]` lookup that was one of the three bug sites.
  assert.doesNotThrow(() =>
    loadApp({
      lang: "en",
      locationSearch: "?paid_order_id=ord_test123",
      fetchImpl: async () => ({ status: 200, json: async () => ticketedOrder() }),
    }),
  );
});

// =============================================================================
// 3. renderOrder() across all 4 languages, both order states
// =============================================================================

for (const lang of LANGS) {
  test(`renderOrder() (held) populates key elements without throwing — ${lang}`, () => {
    const h = loadApp({ lang });
    const order = heldOrder();

    assert.doesNotThrow(() => h.app.renderOrder(order));

    // booking reference
    assert.equal(h.el("booking-ref").textContent, "ABC123", "booking-ref not populated");

    // route summary
    assert.match(h.el("route-summary").textContent, /BKK/, "route-summary not populated");

    // stripe pay button: visible, enabled, and labelled from this language's dict
    const stripeBtn = h.el("stripe-pay-btn");
    assert.equal(stripeBtn.style.display, "block", "stripe-pay-btn should be shown when awaiting payment");
    assert.equal(stripeBtn.disabled, false, "stripe-pay-btn should be enabled");
    assert.equal(
      stripeBtn.textContent,
      h.app.translations[lang].stripe_pay_btn,
      `stripe-pay-btn should be labelled in ${lang}`,
    );

    // confirmation title populated (by applyLang, in the held state)
    assert.equal(
      h.el("confirmation-title").textContent,
      h.app.translations[lang].reservation_held,
      `confirmation-title should carry the ${lang} "reservation held" copy`,
    );
    assert.notEqual(h.el("confirmation-title").textContent, "", "confirmation-title is empty");
  });

  test(`renderOrder() (ticketed) populates key elements without throwing — ${lang}`, () => {
    const h = loadApp({ lang });
    const order = ticketedOrder();

    assert.doesNotThrow(() => h.app.renderOrder(order));

    assert.equal(h.el("booking-ref").textContent, "XYZ789", "booking-ref not populated");
    assert.equal(
      h.el("confirmation-title").textContent,
      h.app.translations[lang].ticketed_title,
      `confirmation-title should read the localised ticketed heading in ${lang}`,
    );
    // in the ticketed state the pay buttons are hidden
    assert.equal(h.el("stripe-pay-btn").style.display, "none", "stripe-pay-btn should be hidden once ticketed");
    assert.equal(h.el("confirm-pay-btn").style.display, "none", "confirm-pay-btn should be hidden once ticketed");
  });
}

// =============================================================================
// 4. Other DOM-rendering / assumed-global-sensitive paths
// =============================================================================

// =============================================================================
// 3b. The hold fee — the document is the product and must stay gated
// =============================================================================

test("a held order keeps the document locked behind the hold fee", () => {
  const h = loadApp({ lang: "en" });
  h.app.renderOrder({ ...heldOrder(), hold_fee: 14.99, hold_fee_currency: "USD" });
  assert.equal(h.el("doc-gate").style.display, "block", "the pay-for-document gate should be shown");
  assert.equal(h.el("doc-actions").style.display, "none", "download/email must stay hidden until paid");
  assert.equal(h.el("doc-gate-price").textContent, "US$14.99", "standard hold price");
});

test("a return/multi-city order shows the higher hold fee", () => {
  const h = loadApp({ lang: "en" });
  h.app.renderOrder({ ...heldOrder(), hold_fee: 19.99, hold_fee_currency: "USD" });
  assert.equal(h.el("doc-gate-price").textContent, "US$19.99", "return/multi-city hold price");
});

test("a ticketed order releases the document without a separate hold fee", () => {
  // Paying the full fare via the confirm-to-fly path obviously entitles the
  // customer to the document — the gate must not block them a second time.
  const h = loadApp({ lang: "en" });
  h.app.renderOrder(ticketedOrder());
  assert.equal(h.el("doc-gate").style.display, "none", "gate should be gone once ticketed");
  assert.equal(h.el("doc-actions").style.display, "flex", "download/email should be available");
});

test("applyLang() localises data-i18n elements for every language", () => {
  for (const lang of LANGS) {
    const h = loadApp({ lang });
    // a representative translated element — the flight tab label
    // (rendered during load via applyLang)
    const el = h.el("tab-flight");
    assert.equal(
      el.textContent,
      h.app.translations[lang].tab_flight,
      `tab-flight should be localised to ${lang}`,
    );
  }
});

test("switching language via the dropdown takes effect on the first change", () => {
  // Regression guard: applyLang must localise using the language it is HANDED,
  // not a stale value re-read from localStorage. The buggy version lagged one
  // click behind (pick Español, page stayed English until the next switch).
  const h = loadApp({ lang: "en" });
  // simulate the user picking Español from the <select>
  h.trigger("lang-select", "change", { target: { value: "es" } });
  assert.equal(
    h.el("tab-flight").textContent,
    h.app.translations.es.tab_flight,
    "picking a language must switch the UI to THAT language immediately, not one click late",
  );
});

test("search-form widgets initialise at load (stepper + calendar wired up)", () => {
  // The passenger stepper, calendar, and airport type-ahead all init at load;
  // if any of that throws, the search button's own listener never attaches and
  // the whole form silently dies. Assert the widgets rendered their labels.
  const h = loadApp({ lang: "en" });
  assert.equal(h.el("pax-trigger").textContent, "1 adult", "passenger stepper should default to 1 adult");
  assert.equal(h.el("departure_date-trigger").textContent, "15 Aug 2026", "calendar should show the default depart date");
  assert.equal(h.el("return_date-trigger").textContent, "Select a date", "empty return date shows the placeholder");
});

test("traveller-details form renders one block per searched passenger", () => {
  // Regression guard: a multi-passenger search must produce one detail block per
  // traveller, or the hold order won't match the offer's passenger count (Duffel
  // rejects it). This broke once when the stepper allowed multi-passenger search
  // but the details form + hold still assumed a single traveller.
  const h = loadApp({ lang: "en" });
  h.app.setSearchedPax({ adults: 2, children: 1, infants: 0 });
  h.app.renderPaxDetails();
  const html = h.el("pax-details").innerHTML;
  assert.match(html, /adult 1/i);
  assert.match(html, /adult 2/i);
  assert.match(html, /child 1/i);
  assert.equal((html.match(/pax-detail"/g) || []).length, 3, "should render exactly 3 traveller blocks");
});

// =============================================================================
// 3c. /api/hold payload — the live-checkout blocker
// =============================================================================

// Drives the REAL traveller-details form end to end: render the blocks, type
// into the actual inputs the app generated, click Hold, and capture what goes
// over the wire. Nothing is stubbed between the input and the payload — that
// gap is precisely where the blank-family_name bug lived.
async function submitHold(h, { given = "Ada", family = "Lovelace", dob = "1990-04-02", email = "ada@example.com" } = {}) {
  let body = null;
  h.setFetch(async (url, opts) => {
    if (String(url).includes("/api/hold") && opts && opts.body) body = JSON.parse(opts.body);
    return { status: 200, json: async () => ({ error: { errors: [{ type: "x", message: "stop here" }] } }) };
  });
  h.app.setSelectedOffer({ id: "off_test" });
  h.app.setSearchedPax({ adults: 1, children: 0, infants: 0 });
  h.app.renderPaxDetails();

  const block = h.el("pax-details").querySelector(".pax-detail");
  assert.ok(block, "renderPaxDetails() produced no traveller block");
  block.querySelector(".pax-given").value = given;
  block.querySelector(".pax-family").value = family;
  block.querySelector(".pax-dob").value = dob;
  h.el("email").value = email;

  await h.trigger("hold-btn", "click");
  return body;
}

test("/api/hold payload carries a non-empty family_name from the last-name field", async () => {
  // The bug that broke live checkout: family_name arrived blank, so Duffel
  // rejected every hold with "Field 'family_name' can't be blank".
  const h = loadApp({ lang: "en" });
  const body = await submitHold(h, { given: "Ada", family: "Lovelace" });
  assert.ok(body, "no /api/hold request was made");
  assert.equal(body.passengers.length, 1);
  const p = body.passengers[0];
  assert.equal(p.family_name, "Lovelace", "family_name must come from the last-name input");
  assert.notEqual(String(p.family_name).trim(), "", "family_name must never be blank");
  assert.equal(p.given_name, "Ada", "given_name must come from the first-name input");
});

test("hold is blocked client-side when the last name is empty (no request sent)", async () => {
  const h = loadApp({ lang: "en" });
  const body = await submitHold(h, { given: "Ada", family: "   " });
  assert.equal(body, null, "a blank last name must not reach the server");
  // and the user is told which field is wrong, inline on that field
  const familyInput = h.el("pax-details").querySelector(".pax-family");
  assert.ok(familyInput.classList.contains("input-error"), "last-name input should be flagged");
  const slot = familyInput.parentElement.querySelector(".field-error");
  assert.match(slot.textContent, /Enter a last name/, "inline last-name error should be shown");
});

test("hold failures render inline, not via alert(), and surface the real reason", async () => {
  const h = loadApp({ lang: "en" });
  h.setFetch(async () => ({
    status: 422,
    json: async () => ({ error: { errors: [{ type: "validation_error", message: "Field 'family_name' can't be blank" }] } }),
  }));
  h.app.setSelectedOffer({ id: "off_test" });
  h.app.setSearchedPax({ adults: 1, children: 0, infants: 0 });
  h.app.renderPaxDetails();
  const blk = h.el("pax-details").querySelector(".pax-detail");
  blk.querySelector(".pax-given").value = "Ada";
  blk.querySelector(".pax-family").value = "Lovelace";
  blk.querySelector(".pax-dob").value = "1990-04-02";
  h.el("email").value = "ada@example.com";
  await h.trigger("hold-btn", "click");
  const box = h.el("hold-error");
  // The message is HTML-escaped on the way in (server text must never be able to
  // inject markup), so match around the escaped apostrophe.
  assert.match(box.innerHTML, /family_name/, "the real Duffel reason must be surfaced");
  assert.match(box.innerHTML, /be blank/, "the real Duffel reason must be surfaced");
  assert.doesNotMatch(box.innerHTML, /already been used/, "must not blame a reused search result");
  assert.ok(box.classList.contains("show"), "the inline error box must be visible");
});

test("demo 'simulate payment' control is hidden unless the server reports test mode", async () => {
  // This button tickets the order out of Peregrin's own Duffel balance with no
  // customer payment. On live keys that would buy a real ticket at Peregrin's
  // expense, so it must never render there. renderOrder() sets its display, so
  // the held-state render is the path that matters.
  const pricing = (extra) => async () => ({
    status: 200,
    json: async () => ({ currency: "USD", standard: 14.99, multi: 19.99, ...extra }),
  });
  const settle = () => new Promise((r) => setImmediate(r));

  const live = loadApp({ lang: "en", fetchImpl: pricing({ test_mode: false }) });
  await settle();
  live.app.renderOrder(heldOrder());
  assert.equal(live.el("confirm-pay-btn").style.display, "none", "must stay hidden on live keys");

  const test = loadApp({ lang: "en", fetchImpl: pricing({ test_mode: true }) });
  await settle();
  test.app.renderOrder(heldOrder());
  assert.equal(test.el("confirm-pay-btn").style.display, "block", "should be available in test mode");
});

// Countries whose "do not buy the ticket until the visa is granted" wording was
// verified against a primary government source (automation/EMBASSY_QUOTES_VERIFIED.md).
// Nothing outside this set may ever be quoted on the page.
const TIER1 = ["Norway", "Germany", "Belgium", "Finland", "Denmark"];
const TIER2 = ["Netherlands", "Italy", "United States", "India", "Sweden", "France", "Austria"];

test("embassy section: every featured country renders with a flag and an attribution", () => {
  const section = html.slice(html.indexOf('class="embassy-grid"'), html.indexOf('data-i18n="embassy_body"'));
  assert.ok(section.length > 500, "embassy section must be present");

  for (const country of TIER1) {
    assert.ok(section.includes(`aria-label="${country}"`), `${country} needs a labelled flag`);
    assert.ok(section.includes(`>${country}</p>`), `${country} must be named on its card`);
  }
  const cards = (section.match(/class="pull-quote embassy-card"/g) || []).length;
  assert.equal(cards, TIER1.length, "one card per verified tier-1 country");
  // Each card carries a quote and a plain attribution line.
  assert.equal((section.match(/class="pull-quote-q"/g) || []).length, TIER1.length, "every card needs a quote");
  assert.equal((section.match(/class="pull-quote-c"/g) || []).length, TIER1.length, "every card needs an attribution");

  for (const country of TIER2) {
    assert.ok(section.includes(`aria-label="${country}"`), `${country} needs a labelled flag in the tier-2 line`);
  }
});

test("legal copy: only verified countries are quoted, and the disclaimer is always present", () => {
  // Spain has no primary source, so it must never appear in shipped copy. The
  // source-provenance comment legitimately names it, so scan comment-free markup.
  const shipped = html.replace(/<!--[\s\S]*?-->/g, "");
  assert.doesNotMatch(shipped, /\bSpain\b|\bSpanish (Embassy|Ministry|consulate)/i, "Spain is not verified");

  // India's onward-ticket requirement is real; a "don't buy the ticket" quote
  // attributed to India is not. Guard the attribution, not the word.
  const indiaCard = html.match(/aria-label="India"[\s\S]{0,600}/);
  if (indiaCard) {
    assert.doesNotMatch(indiaCard[0], /do not buy|don't buy|before buying|should be purchased/i,
      "no 'don't buy' wording may be attributed to India");
  }

  // Attributed sources must belong to a verified country.
  const attributions = [...html.matchAll(/class="pull-quote-c">([^<]+)</g)].map((m) => m[1]);
  assert.equal(attributions.length, TIER1.length, "one attribution per verified card");
  for (const a of attributions) {
    const ok = TIER1.some((c) => new RegExp(c.slice(0, 4), "i").test(a) || /Norwegian|German|Belgian|Finnish|Danish/i.test(a));
    assert.ok(ok, `attribution is not from a verified source: ${a}`);
  }

  const h = loadApp({ lang: "en" });
  const t = h.app.translations;
  for (const lang of LANGS) {
    // Surrounding copy is localised; the quotes themselves stay in English, so
    // there are deliberately no embassy_quote/embassy_cite keys any more.
    assert.ok(t[lang].embassy_h && t[lang].embassy_intro, `${lang} is missing the embassy heading copy`);
    assert.ok(t[lang].embassy_also && t[lang].embassy_also.length > 40, `${lang} is missing the tier-2 line`);
    assert.equal(t[lang].embassy_quote, undefined, `${lang}: official quotes must not be translated`);
    // Protective disclaimer, always shipped.
    const d = t[lang].footer_disclaimer;
    assert.ok(d && d.length > 200, `${lang} footer_disclaimer must be the full text`);
  }
});

test("customer-facing errors never leak internal terms", () => {
  // "check server logs" / "Duffel test balance" were shown to real customers.
  const h = loadApp({ lang: "en" });
  const t = h.app.translations;
  for (const lang of LANGS) {
    for (const key of ["err_search_failed", "err_confirm_failed"]) {
      const v = t[lang][key];
      assert.ok(v && v.length > 10, `${lang}.${key} must be a real message`);
      assert.doesNotMatch(v, /server log|duffel|balance|dashboard|api|stripe/i,
        `${lang}.${key} must not mention internal systems`);
    }
  }
});

test("accommodation stays hidden while ENABLE_ACCOMMODATION is off", () => {
  // The flow is gated on unapproved Duffel Stays access, so it must not be
  // reachable. routeView() runs at load and used to un-hide #stays-flow on every
  // navigation, so asserting the post-load state covers that guard too.
  const h = loadApp({ lang: "en" });
  assert.equal(h.el("stays-flow").style.display, "none", "stays flow must be hidden");
  assert.equal(h.el("stays-flow").classList.contains("active"), false, "stays flow must not be active");
  // Even a direct call must not reveal it.
  h.app.switchTab("stays");
  assert.equal(h.el("stays-flow").classList.contains("active"), false, "switchTab('stays') must be a no-op");
  // (Not asserting flight-flow's "active" class: the stub doesn't seed class
  // attributes from the static markup, so it was never set here to begin with.)
});

test("accommodation booking is blocked when the guest last name is empty", async () => {
  // The stays guest form carried the identical blank-name hazard that broke live
  // flight holds. It is gated on Duffel Stays approval, so this guards it before
  // that flow ever goes live.
  const h = loadApp({ lang: "en" });
  let sent = false;
  h.setFetch(async (url) => {
    if (String(url).includes("/api/stays/book")) sent = true;
    return { status: 200, json: async () => ({}) };
  });
  h.app.setSelectedRate({ id: "rate_test" });
  h.el("stays-given-name").value = "Ada";
  h.el("stays-family-name").value = "   "; // whitespace must not count
  h.el("stays-born-on").value = "1990-04-02";
  h.el("stays-email").value = "ada@example.com";

  await h.trigger("stays-book-btn", "click");
  assert.equal(sent, false, "a blank guest last name must not reach the supplier");
  assert.ok(h.el("stays-family-name").classList.contains("input-error"), "last-name input should be flagged");
});

test("test-mode badge shows ONLY when the server reports test_mode", async () => {
  // The badge is a dev aid that was once always-on and shipped to production,
  // where it was factually wrong. It must never reappear on live keys — so the
  // live case and every failure mode are asserted, not just the happy path.
  const pricing = (extra) => async () => ({
    status: 200,
    json: async () => ({ currency: "USD", standard: 14.99, multi: 19.99, ...extra }),
  });
  const settle = () => new Promise((r) => setImmediate(r));

  const live = loadApp({ lang: "en", fetchImpl: pricing({ test_mode: false }) });
  await settle();
  assert.equal(live.el("demo-badge").style.display, "none", "must stay hidden on live keys");

  // An older/!changed server response with no test_mode field must also stay hidden.
  const missing = loadApp({ lang: "en", fetchImpl: pricing({}) });
  await settle();
  assert.equal(missing.el("demo-badge").style.display, "none", "must stay hidden when the field is absent");

  const test = loadApp({ lang: "en", fetchImpl: pricing({ test_mode: true }) });
  await settle();
  assert.equal(test.el("demo-badge").style.display, "", "should be revealed in test mode");
});

test("every language defines the same i18n keys (no missing translations)", () => {
  // Guards the real risk when adding copy across four languages: a key added to
  // `en` but forgotten elsewhere silently falls back to English on that locale.
  const h = loadApp({ lang: "en" });
  const t = h.app.translations;
  const en = Object.keys(t.en).sort();
  for (const lang of ["es", "ru", "hi"]) {
    const keys = Object.keys(t[lang]);
    const missing = en.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !en.includes(k));
    assert.deepEqual(missing, [], `${lang} is missing: ${missing.join(", ")}`);
    assert.deepEqual(extra, [], `${lang} has keys absent from en: ${extra.join(", ")}`);
  }
});

test("view helpers (show / switchTab / startCountdown) run without throwing", () => {
  const h = loadApp();
  assert.doesNotThrow(() => h.app.show("passenger-section"));
  assert.doesNotThrow(() => h.app.switchTab("stays"));
  assert.doesNotThrow(() => h.app.switchTab("flight"));
  assert.doesNotThrow(() => h.app.startCountdown(new Date(Date.now() + 5000).toISOString()));
});

test("Stripe 'Pay with card' handler runs without throwing (assumed-global site #2) — success", async () => {
  const h = loadApp({
    lang: "en",
    fetchImpl: async () => ({ status: 200, json: async () => ({ url: "https://checkout.example/session" }) }),
  });
  h.app.setCurrentOrder(heldOrder());
  await h.trigger("stripe-pay-btn", "click");
  assert.equal(h.location.href, "https://checkout.example/session", "should redirect to the Stripe Checkout URL");
});

test("Stripe 'Pay with card' handler surfaces the localised message on 501 — es", async () => {
  const h = loadApp({
    lang: "es",
    fetchImpl: async () => ({ status: 501, json: async () => ({ error: "not configured" }) }),
  });
  h.app.setCurrentOrder(heldOrder());
  await h.trigger("stripe-pay-btn", "click");
  assert.equal(
    h.el("checkout-status").textContent,
    h.app.translations.es.checkout_unavailable,
    "should show the localised 'card payments not set up' message",
  );
});
