// Reservation-PDF document tests.
//
// The wording in this document is the legally sensitive part of the product: it
// goes to embassies and check-in desks, and it must never claim a ticket has
// been purchased. The rendered PDF compresses and font-subsets its text, so it
// can't be grepped after the fact — instead we render through a fake pdfkit
// document that records every text() call, which is both faster and exact.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReservationPdf } from "../pdf.js";

// Minimal pdfkit stand-in: records text, ignores drawing. Every chainable call
// returns the doc, matching pdfkit's fluent API.
function fakeDoc() {
  const lines = [];
  const doc = {
    y: 0,
    _lines: lines,
    text(str) { lines.push(String(str)); this.y += 12; return this; },
    font() { return this; },
    fontSize() { return this; },
    fillColor() { return this; },
    strokeColor() { return this; },
    lineWidth() { return this; },
    lineCap() { return this; },
    lineJoin() { return this; },
    opacity() { return this; },
    moveTo() { return this; },
    lineTo() { return this; },
    bezierCurveTo() { return this; },
    roundedRect() { return this; },
    rect() { return this; },
    stroke() { return this; },
    fill() { return this; },
    fillAndStroke() { return this; },
    save() { return this; },
    restore() { return this; },
    dash() { return this; },
    undash() { return this; },
    moveDown(n = 1) { this.y += 12 * n; return this; },
  };
  return doc;
}

const brand = { name: "Peregrin", accent: "#1c6f8c" };

function orderFixture(overrides = {}) {
  return {
    booking_reference: "ABC123",
    airline: "Singapore Airlines",
    route_summary: "BKK -> SIN",
    awaiting_payment: true,
    payment_required_by: "2026-08-01T00:00:00Z",
    passenger_names: ["Ada Lovelace"],
    passenger_name: "Ada Lovelace",
    itinerary: [
      {
        origin: "BKK",
        destination: "SIN",
        segments: [
          {
            flight_number: "SQ973", airline: "Singapore Airlines", aircraft: "Boeing 787",
            origin_iata: "BKK", origin_name: "Bangkok",
            destination_iata: "SIN", destination_name: "Singapore",
            departure_date: "Sat, 15 Aug 2026", departure_time: "10:50",
            arrival_date: "Sat, 15 Aug 2026", arrival_time: "14:25",
            duration: "2h 35m", layover_after: null,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function render(order) {
  const doc = fakeDoc();
  renderReservationPdf(doc, order, brand);
  return doc._lines.join("\n");
}

test("PDF header reads as a trip with an airline reservation code", () => {
  const out = render(orderFixture());
  assert.match(out, /Your trip to Singapore/, "header should name the destination city");
  assert.match(out, /Airline reservation code: ABC123 \(Singapore Airlines\)/, "code line should carry PNR + carrier");
  assert.match(out, /Booking confirmed/, "status should read Booking confirmed");
});

test("PDF carries the four required fine-print lines and the verification note", () => {
  const out = render(orderFixture());
  assert.match(out, /prepared to support a proof-of-onward-travel \/ visa application/);
  assert.match(out, /E-ticket issuance is subject to completion of payment/);
  assert.match(out, /times shown are local to each airport/i);
  assert.match(out, /passport and any required visas/i);
  // The verify mechanic is the whole trust story — it must survive restructuring.
  assert.match(out, /can be independently verified with Singapore Airlines/i);
});

test("PDF never claims a ticket was purchased", () => {
  for (const order of [orderFixture(), orderFixture({ awaiting_payment: false })]) {
    const out = render(order);
    // Any mention of "purchased ticket" must be a negation.
    for (const m of out.match(/[^.]*purchased ticket[^.]*/gi) || []) {
      assert.match(m, /not a purchased ticket/i, `unqualified purchase claim: "${m.trim()}"`);
    }
    assert.doesNotMatch(out, /ticket (has been|was) (issued|purchased|bought)(?! only)/i,
      "must not state a ticket has been issued outright");
  }
});

test("PDF renders every passenger on a multi-traveller reservation", () => {
  const out = render(orderFixture({ passenger_names: ["Ada Lovelace", "Grace Hopper", "Alan Turing"] }));
  assert.match(out, /PASSENGERS/, "heading should pluralise");
  for (const n of ["Ada Lovelace", "Grace Hopper", "Alan Turing"]) {
    assert.match(out, new RegExp(n), `${n} missing from the document`);
  }
});

test("PDF renders without throwing when optional fields are absent", () => {
  // Real orders have come back without an itinerary or carrier before.
  assert.doesNotThrow(() =>
    render({ booking_reference: "XYZ789", awaiting_payment: false, itinerary: [], passenger_names: [] }));
});
