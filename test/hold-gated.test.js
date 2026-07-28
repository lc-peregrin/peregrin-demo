// Live-hold gating and charge-safety tests.
//
// Duffel live hold orders are gated per account; until they are enabled a
// live-mode hold fails with 403 insufficient_permissions. The site runs live
// Stripe keys, so the property these tests protect is: NO customer can be
// charged without holding a real reservation. That rests on ordering (the hold
// exists before any Stripe session can be created) and on the webhook never
// keeping money for a failed issuance. Same source-level style as
// ticket-conversion.test.js, which guards the same class of risk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(join(__dirname, "..", "server.js"), "utf8");
const HTML = readFileSync(join(__dirname, "..", "public", "index.html"), "utf8");

// The body of one Express route, from its registration to the next one.
const routeBody = (path) => {
  const start = SERVER.indexOf(`"${path}"`);
  assert.ok(start > -1, `route ${path} must exist`);
  const end = SERVER.indexOf("app.", SERVER.indexOf("});", start));
  return SERVER.slice(start, end);
};

test("a gated live hold maps to hold_unavailable instead of leaking Duffel wording", () => {
  const body = routeBody("/api/hold");
  assert.match(body, /insufficient_permissions/, "must recognise Duffel's gating error");
  assert.match(body, /hold orders/i, "matched on the hold-specific message, not any 403");
  assert.match(body, /type: "hold_unavailable"/, "must emit the stable type the frontend keys on");
  assert.match(body, /status\(503\)/, "a paused service is a 503, not a client error");
  // The customer-facing message must be the friendly one, not Duffel's.
  assert.match(body, /No charge has been made/, "must reassure that no money moved");
  assert.doesNotMatch(body.slice(body.indexOf('type: "hold_unavailable"')),
    /Your team is not allowed/, "Duffel's account-level wording must never reach a customer");
});

test("the frontend shows the calm paused message for hold_unavailable", () => {
  assert.match(HTML, /first\.type === "hold_unavailable"/,
    "describeHoldError must branch on the stable type");
  // The branch must run before the generic fallbacks so the raw message never wins.
  const fn = HTML.slice(HTML.indexOf("function describeHoldError"));
  assert.ok(fn.indexOf('"hold_unavailable"') < fn.indexOf("multiple offers"),
    "hold_unavailable must be handled before the generic branches");
});

test("the paused copy exists in all four languages", () => {
  const count = (re) => (HTML.match(re) || []).length;
  assert.equal(count(/hold_err_paused_t:/g), 4, "title in en, es, ru, hi");
  assert.equal(count(/hold_err_paused_d:/g), 4, "body in en, es, ru, hi");
});

test("no Stripe session can be created without an existing Duffel order", () => {
  // Both customer-facing checkout routes must look the order up with Duffel
  // BEFORE creating a Checkout Session, so a failed/never-created hold can
  // never reach a payment page. This is the ordering the whole safety story
  // rests on while live holds are disabled.
  for (const path of ["/api/order/:id/hold-checkout", "/api/order/:id/checkout"]) {
    const body = routeBody(path);
    const lookup = body.indexOf("/air/orders/");
    const session = body.indexOf("stripe.checkout.sessions.create");
    assert.ok(lookup > -1 && session > -1, `${path}: must both look up the order and create a session`);
    assert.ok(lookup < session, `${path}: the Duffel order lookup must come before the Stripe session`);
  }
});

test("the fare webhook path refunds if ticketing fails after the charge", () => {
  // The fare branch must go through issueTicketAfterPayment (idempotency +
  // automatic refund), never call payOrderWithDuffelBalance bare — the old
  // shape charged the customer and only logged a failed issuance.
  const webhook = SERVER.slice(SERVER.indexOf('"/api/stripe/webhook"'), SERVER.indexOf("app.use(express.json())"));
  const fareBranch = webhook.slice(webhook.lastIndexOf("} else {"));
  assert.match(fareBranch, /issueTicketAfterPayment\(orderId, session\)/,
    "fare payments must use the guarded issuance path");
  assert.doesNotMatch(fareBranch, /payOrderWithDuffelBalance\(/,
    "no bare balance-payment call from the webhook — that shape kept money on failure");
  // And the guarded path really does refund.
  const fn = SERVER.slice(SERVER.indexOf("async function issueTicketAfterPayment"));
  assert.match(fn.slice(0, fn.indexOf("\n}")), /stripe\.refunds\.create/,
    "issuance failure must trigger a refund");
});
