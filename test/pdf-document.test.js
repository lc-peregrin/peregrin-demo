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
  const images = [];
  const doc = {
    y: 0,
    _lines: lines,
    _images: images,
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
    image(buf, x, y, opts) { this._images.push({ buf, x, y, opts }); return this; },
    moveDown(n = 1) { this.y += 12 * n; return this; },
  };
  return doc;
}

const brand = { name: "Peregrin", accent: "#1c6f8c" };

function orderFixture(overrides = {}) {
  return {
    booking_reference: "ABC123",
    airline: "Singapore Airlines",
    airline_iata: "SQ",
    created_at: "2026-07-20T08:00:00Z",
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
            flight_number: "SQ973", airline: "Singapore Airlines", aircraft: "Boeing 787-10",
            airline_iata: "SQ", cabin: "economy", operated_by: "",
            origin_terminal: "2", destination_terminal: "3",
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

function render(order, assets = {}) {
  const doc = fakeDoc();
  renderReservationPdf(doc, order, brand, assets);
  return doc._lines.join("\n");
}

function renderDoc(order, assets = {}) {
  const doc = fakeDoc();
  renderReservationPdf(doc, order, brand, assets);
  return doc;
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

// ---------------------------------------------------------------------------
// Real order data on the document (CLAUDE_CODE_HANDOFF_2026-07-24_PDF_ITINERARY)
// ---------------------------------------------------------------------------

test("PDF prints the real flight number, carrier, aircraft and cabin per leg", () => {
  const out = render(orderFixture());
  assert.match(out, /SQ973/, "flight number must come from the order");
  assert.match(out, /Singapore Airlines/, "operating carrier must be named");
  assert.match(out, /Boeing 787-10/, "aircraft type must come from the order");
  assert.match(out, /Economy/, "cabin class must be shown");
  // No bracketed placeholders may survive anywhere in the document.
  assert.doesNotMatch(out, /\[(Carrier|Flight|Aircraft)[^\]]*\]/i, "placeholders must be replaced with real data");
});

test("a codeshare is labelled with its operating carrier, and a direct flight is not", () => {
  const codeshare = orderFixture();
  codeshare.itinerary[0].segments[0].operated_by = "SilkAir";
  assert.match(render(codeshare), /Operated by SilkAir/, "codeshare must name the operating carrier");
  // The plain fixture is not a codeshare, so the line must not appear at all.
  assert.doesNotMatch(render(orderFixture()), /Operated by/, "no 'Operated by' line on a direct flight");
});

test("terminals appear only when the airline supplied them", () => {
  assert.match(render(orderFixture()), /Bangkok \(Terminal 2\)/, "terminal shown when present");

  const noTerminals = orderFixture();
  noTerminals.itinerary[0].segments[0].origin_terminal = "";
  noTerminals.itinerary[0].segments[0].destination_terminal = "";
  const out = render(noTerminals);
  assert.doesNotMatch(out, /Terminal/, "no empty Terminal label when Duffel gives none");
  assert.match(out, /Bangkok/, "the airport itself is still named");
});

test("passenger titles and a real issue date come from the order", () => {
  const out = render(orderFixture({ passenger_names: ["MR Alan Turing", "MS Ada Lovelace"] }));
  assert.match(out, /MR Alan Turing/);
  assert.match(out, /MS Ada Lovelace/);
  assert.match(out, /Issued .*2026/, "issue date must be printed");
});

test("the verify QR is embedded and points at this reservation", () => {
  const verifyUrl = "https://www.peregrin.travel/verify?ref=ABC123";
  const doc = renderDoc(orderFixture(), { qr: Buffer.from("fake-png"), verifyUrl });
  assert.equal(doc._images.length, 1, "exactly one QR image");
  assert.match(doc._lines.join("\n"), /Scan to verify/, "the QR needs a caption");
  assert.match(doc._lines.join("\n"), new RegExp(verifyUrl.replace(/[?]/g, "\\?")), "verify URL must be printed too");
});

test("a missing logo or QR degrades instead of breaking the document", () => {
  // No assets at all: this is the offline / fetch-failed path.
  const bare = render(orderFixture());
  assert.match(bare, /SQ973/, "the itinerary must still render with no assets");
  assert.doesNotMatch(bare, /Scan to verify/, "no QR caption when there is no QR");

  // A logo whose SVG blows up the parser must not take the document with it.
  const exploding = {
    logos: { SQ: "<svg>broken" },
    svgToPdf: () => { throw new Error("bad svg"); },
  };
  const out = render(orderFixture(), exploding);
  assert.match(out, /SQ973/, "a failing logo must not stop generation");
});

test("the document contains no em dashes and no GDS or spam wording", () => {
  for (const order of [orderFixture(), orderFixture({ awaiting_payment: false })]) {
    const out = render(order, { qr: Buffer.from("x"), verifyUrl: "https://www.peregrin.travel/verify?ref=ABC123" });
    assert.doesNotMatch(out, /—/, "WRITING_STYLE.md: no em dashes anywhere in the document");
    assert.doesNotMatch(out, /\bGDS\b|Global Distribution System/i, "Peregrin books airline-direct via Duffel");
    assert.doesNotMatch(out, /spam|junk/i, "email reassurance belongs in the email, not the document");
  }
});

test("data protection wording credits Duffel, and the held-reservation note survives", () => {
  const out = render(orderFixture());
  assert.match(out, /created via Duffel, our airline booking provider/i, "must name Duffel, not a GDS");
  assert.match(out, /not a purchased ticket/i, "the held-vs-ticketed note must stay");
  assert.match(out, /This is a held reservation\. A ticket is only issued if and when payment is completed\./,
    "the corrected two-sentence phrasing");
  assert.match(out, /lapses automatically/i, "the lapse language must stay");
});
