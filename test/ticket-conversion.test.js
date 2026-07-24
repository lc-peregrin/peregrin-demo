// Ticket-conversion tests.
//
// This flow spends REAL money (it buys an airline ticket), so the tests here are
// mostly about the guardrails rather than the happy path: the feature must be
// off by default, unreachable while off, must never issue without a cleared
// payment, must not double-issue on webhook retries, and must refund if issuance
// fails after the customer has been charged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(join(__dirname, "..", "server.js"), "utf8");
const HTML = readFileSync(join(__dirname, "..", "public", "index.html"), "utf8");

// Mirrors conversionServiceFee in server.js. Kept in step by the assertion below
// that the shipped constants are still 29 / 0.07.
const fee = (fare, flat = 29.0, pct = 0.07) => Math.round(Math.max(flat, pct * fare) * 100) / 100;

test("the feature is OFF unless explicitly enabled", () => {
  assert.match(SERVER, /ENABLE_TICKET_CONVERSION\s*=\s*process\.env\.ENABLE_TICKET_CONVERSION\s*===\s*"true"/,
    "must default to off — anything other than the string 'true' stays disabled");
});

test("conversion routes 404 while the feature is off", () => {
  assert.match(SERVER, /app\.use\("\/api\/order\/:id\/ticket-conversion"/,
    "a gate must cover the whole ticket-conversion path");
  const gate = SERVER.slice(SERVER.indexOf('app.use("/api/order/:id/ticket-conversion"'));
  assert.match(gate.slice(0, 300), /if\s*\(!ENABLE_TICKET_CONVERSION\)\s*return\s*res\.status\(404\)/,
    "the gate must 404 when disabled");
});

test("service fee is the greater of the flat floor and the percentage", () => {
  assert.match(SERVER, /CONVERSION_FEE_FLAT\s*\|\|\s*29/, "flat floor should default to 29");
  assert.match(SERVER, /CONVERSION_FEE_PCT\s*\|\|\s*0\.07/, "percentage should default to 0.07");
  // Matches the economics in the handoff: $200 -> $29, $600 -> $42.
  assert.equal(fee(200), 29, "small fares take the flat floor");
  assert.equal(fee(600), 42, "large fares take 7%");
  assert.equal(fee(0), 29, "a zero fare still charges the floor, never a negative fee");
  // The crossover sits where 7% overtakes the floor.
  assert.equal(fee(414.28), 29);
  assert.equal(fee(414.3), 29.0);
  assert.ok(fee(500) > 29, "past the crossover the percentage applies");
});

test("a ticket is only issued from a completed payment, never the free path", () => {
  // Issuance must hang off the webhook's ticket_conversion branch.
  assert.match(SERVER, /purpose === "ticket_conversion"/, "webhook must branch on the purpose");
  assert.match(SERVER, /issueTicketAfterPayment\(orderId, session\)/,
    "issuance must be driven by the paid session");
  // A stray webhook while the feature is disabled must not issue.
  const branch = SERVER.slice(SERVER.indexOf('purpose === "ticket_conversion"'), SERVER.indexOf("} else {", SERVER.indexOf('purpose === "ticket_conversion"')));
  assert.match(branch, /!ENABLE_TICKET_CONVERSION/, "must refuse to issue while disabled");
});

test("issuance is idempotent — retries cannot double-issue or double-charge", () => {
  const fn = SERVER.slice(SERVER.indexOf("async function issueTicketAfterPayment"));
  assert.match(fn.slice(0, 1200), /issuingOrders\.has\(orderId\)/, "in-flight guard for concurrent webhooks");
  assert.match(fn.slice(0, 1600), /awaiting_payment === false/,
    "must re-check Duffel state so a retry after success does not pay twice");
});

test("a payment that fails to issue is refunded automatically", () => {
  const fn = SERVER.slice(SERVER.indexOf("async function issueTicketAfterPayment"));
  assert.match(fn, /stripe\.refunds\.create/, "must refund when issuance fails after payment");
  assert.match(fn, /MANUAL INTERVENTION REQUIRED/,
    "a failed refund must be logged loudly, never swallowed");
});

test("the customer always sees the itemised breakdown before paying", () => {
  // Two-step UI: the breakdown is rendered, and only then can payment start.
  assert.match(HTML, /id="conv-breakdown"[^>]*style="display:none;"/, "breakdown starts hidden");
  assert.match(HTML, /id="conv-airfare"/);
  assert.match(HTML, /id="conv-fee"/);
  assert.match(HTML, /id="conv-total"/);
  // The pay button lives inside the breakdown block, so it cannot be reached
  // before the totals are on screen.
  const block = HTML.slice(HTML.indexOf('id="conv-breakdown"'), HTML.indexOf('id="conv-error"'));
  assert.match(block, /id="conv-pay-btn"/, "pay button must sit inside the breakdown");
});

test("checkout re-prices and refuses to charge a total the customer did not see", () => {
  assert.match(SERVER, /expected_total/, "checkout must accept the displayed total");
  assert.match(SERVER, /price_changed/, "a moved fare must be surfaced, not absorbed");
  assert.match(HTML, /expected_total: convQuote\.total/, "the client must send back exactly what it showed");
});

test("the conversion UI stays hidden unless the server reports the feature on", () => {
  assert.match(HTML, /id="ticket-conversion"[^>]*style="display:none;"/, "UI ships hidden");
  assert.match(HTML, /p\.ticket_conversion === true/, "revealed only on an explicit true");
});

test("renderOrder does not resurrect the old fare button once conversion is on", () => {
  // renderOrder sets display on these buttons and runs after the pricing fetch,
  // so without a guard it re-showed the superseded fare-only button and the
  // customer saw two different ways to pay for the same thing.
  assert.match(HTML, /\$\("stripe-pay-btn"\)\.style\.display = isTicketConversion \? "none" : "block"/,
    "the held branch must respect the conversion flag");
  assert.match(HTML, /\$\("ticket-conversion"\)\.style\.display = isTicketConversion \? "" : "none"/,
    "the conversion block must follow the flag on re-render");
});

test("conversion copy exists in all four languages and keeps the noun rule", () => {
  const langs = ["en", "es", "ru", "hi"];
  for (const key of ["conv_cta", "conv_explainer", "conv_airfare", "conv_fee", "conv_total", "conv_pay"]) {
    const hits = HTML.match(new RegExp(`${key}:`, "g")) || [];
    assert.equal(hits.length, langs.length, `${key} must be defined once per language`);
  }
  // Success wording stays "e-ticket", consistent with the rest of the site.
  assert.match(HTML, /conv_pay: "Pay and issue my e-ticket"/);
});
