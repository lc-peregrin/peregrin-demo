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
    if (idM || i18nM) els.push({ id: idM ? idM[1] : null, i18n: i18nM ? i18nM[1] : null, value: valM ? valM[1] : null });
  }
  return els;
}

const inlineScript = extractInlineScript(html);
const markup = parseMarkup(html);

// ---- minimal DOM element stub ------------------------------------------------
function makeEl(id) {
  return {
    id: id || null,
    _text: "",
    _html: "",
    _i18n: null,
    value: "",
    disabled: false,
    style: { display: "", setProperty() {} },
    classList: (() => {
      const s = new Set();
      return {
        add: (c) => s.add(c),
        remove: (c) => s.delete(c),
        contains: (c) => s.has(c),
        toggle: (c, force) => {
          const on = force === undefined ? !s.has(c) : !!force;
          on ? s.add(c) : s.delete(c);
          return on;
        },
      };
    })(),
    // Real DOM allows many listeners per event, and the app relies on that
    // (e.g. both applyLang and the search widgets listen to lang-select's
    // "change"). Storing a single handler would silently drop one of them.
    _handlers: {},
    addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
    getAttribute(name) { return name === "data-i18n" ? this._i18n : null; },
    setAttribute() {},
    closest() { return null; },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    appendChild() {},
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
  };
}

// ---- load the app into a fresh minimal environment --------------------------
// Returns handles for driving/asserting. Any read of an identifier that isn't a
// standard JS built-in or one of the browser globals seeded below will throw a
// ReferenceError while the script runs — which is exactly the bug class we guard.
function loadApp({ lang = "en", locationSearch = "", fetchImpl } = {}) {
  // Default input values declared in the markup (value="..."), so the stub
  // reflects the same starting state the real page loads with.
  const idValues = {};
  markup.forEach((e) => { if (e.id && e.value != null) idValues[e.id] = e.value; });

  const registry = new Map();
  const getEl = (id) => {
    if (!registry.has(id)) {
      const el = makeEl(id);
      if (idValues[id] != null) el.value = idValues[id];
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
    createElement: () => makeEl(),
    // The popover widgets close themselves via a document-level click listener.
    addEventListener(ev, fn) { (documentHandlers[ev] = documentHandlers[ev] || []).push(fn); },
    documentElement,
  };

  const window = { open() {}, location };

  const defaultFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

  const sandbox = {
    document,
    window,
    location,
    history: { replaceState() {} },
    navigator: {},
    localStorage,
    console,
    alert: () => {},
    fetch: fetchImpl || defaultFetch,
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
    };`;

  vm.runInContext(inlineScript + exposeSrc, context, { filename: "index.html:inline-script" });

  return {
    app: sandbox.__app,
    el: getEl,
    location,
    // Fire every captured handler for an event, e.g. trigger("stripe-pay-btn", "click").
    // Returns a promise so async handlers can be awaited.
    trigger: (id, ev, arg) => Promise.all((getEl(id)._handlers[ev] || []).map((fn) => fn(arg))),
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
    assert.equal(h.el("confirmation-title").textContent, "Ticketed", "confirmation-title should read Ticketed");
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
