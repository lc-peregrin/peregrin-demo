// /hotels: on-site hotel booking via LiteAPI (sandbox). Real bookings, guest
// pays through LiteAPI's payment SDK, Peregrin never sees cards.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { renderHotelsPage, renderBookingPage, renderCancelPage, renderCompletePage, HOTELS_PATHS, HOTELS_COPY, PAYMENT_SDK_URL } from "../hotels.js";
import { cancelDeadline, normaliseRates, normalisePrebook, normaliseCancel, normaliseBooking, signBooking, verifyBooking, HOTEL_MARGIN_PCT } from "../liteapi.js";
import { renderHotelPdf, winAnsi, utcStamp } from "../hotel-pdf.js";
import { sendConfirmationEmail } from "../hotel-booking.js";

const SERVER = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const ORIGIN = "https://www.peregrin.travel";

const rate = (tag, total, extra = {}) => ({
  name: "Room", boardName: "Room Only",
  retailRate: { total: [{ amount: total, currency: "USD" }], suggestedSellingPrice: [{ amount: extra.ssp ?? total, currency: "USD" }], taxesAndFees: extra.fees || null },
  cancellationPolicies: { refundableTag: tag, cancelPolicyInfos: tag === "RFN" ? [{ cancelTime: "2026-12-11 10:00:00", amount: 50, currency: "USD", timezone: "GMT" }] : [] },
});
const offer = (id, r) => ({ offerId: id, rates: [r], offerRetailRate: { amount: r.retailRate.total[0].amount, currency: "USD" }, suggestedSellingPrice: { amount: r.retailRate.suggestedSellingPrice[0].amount, currency: "USD" } });

test("four language routes: self-canonical, full hreflang cluster, unique titles, in the sitemap", () => {
  for (const [lang, p] of Object.entries(HOTELS_PATHS)) {
    const html = renderHotelsPage({ lang, origin: ORIGIN });
    assert.match(html, new RegExp(`<html lang="${lang}">`));
    assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN}${p}">`));
    for (const [l, q] of Object.entries(HOTELS_PATHS)) assert.ok(html.includes(`hreflang="${l}" href="${ORIGIN}${q}"`));
    assert.ok(html.includes(`hreflang="x-default" href="${ORIGIN}/hotels"`));
  }
  assert.equal(new Set(Object.values(HOTELS_COPY).map((c) => c.title)).size, 4);
  assert.match(SERVER, /Object\.values\(HOTELS_PATHS\)\.map\(\(p\) => \(\{ loc: `\$\{SITE_ORIGIN\}\$\{p\}`/);
});

test("every language has every copy key", () => {
  const keys = (o, pre = "") => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? keys(v, pre + k + ".") : [pre + k]));
  const en = keys(HOTELS_COPY.en).sort();
  for (const l of ["es", "ru", "hi"]) assert.deepEqual(keys(HOTELS_COPY[l]).sort(), en, `${l} keys`);
});

test("copy rules: no em dashes anywhere; never hold, fake or dummy; says bookings are real", () => {
  for (const [lang, c] of Object.entries(HOTELS_COPY)) {
    assert.ok(!JSON.stringify(c).includes("—"), `${lang}: no em dash`);
  }
  assert.doesNotMatch(JSON.stringify(HOTELS_COPY.en), /\b(hold|holds|held|fake|dummy)\b/i);
  assert.equal(HOTELS_COPY.en.visa_line, "Need it for a visa? Keep Free cancellation on.");
  assert.match(HOTELS_COPY.en.real, /real hotel bookings/);
  assert.equal(HOTELS_COPY.en.nonref_warn, "This room cannot be refunded.");
  for (const lang of Object.keys(HOTELS_PATHS)) {
    const html = renderHotelsPage({ lang, origin: ORIGIN });
    assert.ok(!html.includes("—"), `${lang} page has no em dash`);
  }
});

test("the Trip.com redirect is gone; the page uses LiteAPI's payment SDK", () => {
  const html = renderHotelsPage({ lang: "en", origin: ORIGIN, sandbox: true });
  assert.doesNotMatch(html, /trip\.com/i);
  assert.ok(html.includes(PAYMENT_SDK_URL));
  assert.match(html, /publicKey: SANDBOX \? "sandbox" : "live"/);
  assert.match(html, /id="hs-free" checked/, "Free cancellation only is ON by default");
  assert.ok(html.includes('id="sandbox-note"'), "sandbox banner shows in sandbox");
  assert.ok(!renderHotelsPage({ lang: "en", origin: ORIGIN, sandbox: false }).includes('id="sandbox-note"'));
});

test("all seven briefed analytics events are wired", () => {
  const all = renderHotelsPage({ lang: "en", origin: ORIGIN }) + renderCompletePage({ lang: "en" }) +
    renderCancelPage({ lang: "en", bk: { bookingId: "B1", status: "CONFIRMED", refundable: true, hotelName: "H", checkin: "2026-12-13", checkout: "2026-12-16" }, links: { page: "/x" }, t: "s" });
  for (const e of ["hotel_search_submitted", "hotel_filter_toggled", "hotel_rate_selected", "hotel_checkout_started", "hotel_booking_confirmed", "hotel_booking_failed", "hotel_booking_cancelled"]) {
    assert.ok(all.includes(`"${e}"`), e);
  }
  assert.match(all, /hotel_rate_selected", \{ refundable: r\.refundable/);
});

test("cancellation deadline: GMT cancelTime becomes a UTC instant; NRFN has none", () => {
  assert.equal(cancelDeadline({ refundableTag: "RFN", cancelPolicyInfos: [{ cancelTime: "2026-12-11 10:00:00", timezone: "GMT" }] }), "2026-12-11T10:00:00.000Z");
  assert.equal(cancelDeadline({ refundableTag: "RFN", cancelPolicyInfos: [{ cancelTime: "2026-12-12 10:00:00" }, { cancelTime: "2026-12-11 08:00:00" }] }), "2026-12-11T08:00:00.000Z", "earliest penalty wins");
  assert.equal(cancelDeadline({ refundableTag: "NRFN", cancelPolicyInfos: [] }), null);
});

test("rates: one card per hotel with cheapest refundable and non-refundable; pay-at-property split; never below SSP", () => {
  const resp = {
    hotels: [{ id: "h1", name: "Hotel One", thumbnail: "t.jpg", stars: 4, address: "1 Road", city_name: "Lisbon" }],
    data: [{ hotelId: "h1", roomTypes: [
      offer("o-rf-dear", rate("RFN", 300)),
      offer("o-rf-cheap", rate("RFN", 250, { fees: [{ included: false, description: "City Tax", amount: 12, currency: "USD" }, { included: true, description: "VAT", amount: 20, currency: "USD" }] })),
      offer("o-nr", rate("NRFN", 200)),
      offer("o-under-ssp", rate("NRFN", 150, { ssp: 180 })),
    ] }],
  };
  const [h] = normaliseRates(resp);
  assert.equal(h.name, "Hotel One"); assert.equal(h.stars, 4);
  assert.equal(h.refundable.offerId, "o-rf-cheap");
  assert.equal(h.refundable.cancelDeadline, "2026-12-11T10:00:00.000Z");
  assert.deepEqual(h.refundable.payAtProperty, [{ description: "City Tax", amount: 12, currency: "USD" }]);
  assert.equal(h.nonRefundable.offerId, "o-nr", "an offer priced under SSP is never shown");
  assert.equal(h.nonRefundable.refundable, false);
});

test("prebook keeps what the payment SDK needs; cancel reads LiteAPI's snake_case refund fields", () => {
  const p = normalisePrebook({ data: { prebookId: "P", transactionId: "T", secretKey: "S", price: 99, currency: "USD", priceDifferencePercent: 0, roomTypes: [{ rates: [rate("RFN", 99)] }] } });
  assert.deepEqual([p.prebookId, p.transactionId, p.secretKey, p.refundable, p.priceChanged], ["P", "T", "S", true, false]);
  assert.deepEqual(normaliseCancel({ data: { status: "CANCELLED", refund_amount: 473.92, cancellation_fee: 0, currency: "USD" } }),
    { status: "CANCELLED", refundAmount: 473.92, cancellationFee: 0, currency: "USD" });
});

test("booking links are signed; a wrong or missing signature is rejected", () => {
  const s = signBooking("aY2hZCx8Y");
  assert.ok(verifyBooking("aY2hZCx8Y", s));
  assert.ok(!verifyBooking("aY2hZCx8Y", "nope"));
  assert.ok(!verifyBooking("other", s));
  assert.ok(!verifyBooking("aY2hZCx8Y", undefined));
});

test("margin is one config value, modest by default, and sent on every rates search", () => {
  assert.ok(HOTEL_MARGIN_PCT > 0 && HOTEL_MARGIN_PCT <= 15);
  const src = fs.readFileSync(new URL("../hotel-booking.js", import.meta.url), "utf8");
  assert.match(src, /margin: HOTEL_MARGIN_PCT/);
});

const BK = { bookingId: "aY2hZCx8Y", status: "CONFIRMED", hotelName: "Meliá Lisboa", hotelAddress: "Rua C, Lisbon, PT", checkin: "2026-12-13", checkout: "2026-12-16",
  guestName: "Test Traveller", email: "delivered@resend.dev", roomName: "Room", board: "Room Only", price: 473.92, currency: "USD", refundable: true,
  cancelDeadline: "2026-12-13T23:59:59.000Z", hotelConfirmationCode: "test", createdAt: "2026-11-22T12:26:19" };

test("confirmation page: status, reference, policy deadline, PDF and cancel links; noindex", () => {
  const html = renderBookingPage({ lang: "en", bk: BK, links: { pdf: "/p", cancel: "/c", page: "/b" } });
  assert.match(html, /Status: Confirmed/);
  assert.ok(html.includes("aY2hZCx8Y") && html.includes("Rua C, Lisbon, PT") && html.includes("Test Traveller"));
  assert.match(html, /data-utc="2026-12-13T23:59:59.000Z" data-tpl="policy_free"/);
  assert.match(html, /id="bk-cancel" href="\/c">Cancel this booking/);
  assert.match(html, /noindex/);
  const nr = renderBookingPage({ lang: "en", bk: { ...BK, refundable: false }, links: { pdf: "/p", cancel: "/c" } });
  assert.doesNotMatch(nr, /id="bk-cancel"/, "no cancel link on a non-refundable booking");
  assert.match(nr, /Non-refundable/);
});

test("hotel PDF renders, titled Hotel booking confirmation, WinAnsi-safe", async () => {
  const { default: PDFDocument } = await import("pdfkit");
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const chunks = []; doc.on("data", (c) => chunks.push(c));
  const done = new Promise((r) => doc.on("end", r));
  renderHotelPdf(doc, { ...BK, hotelName: "Отель Дубай Meliá" });
  doc.end(); await done;
  assert.ok(Buffer.concat(chunks).length > 1500);
  assert.equal(winAnsi("Отель Meliá — x"), "Meliá - x");
  assert.equal(utcStamp("2026-11-22T12:26:19"), "22 Nov 2026, 12:26 UTC", "LiteAPI timestamps are UTC");
});

test("confirmation email: to the guest, PDF attached, booking and cancel links, localised", async () => {
  const orig = globalThis.fetch; let sent;
  globalThis.fetch = async (url, opts) => { sent = { url, body: JSON.parse(opts.body) }; return { ok: true }; };
  try {
    const ok = await sendConfirmationEmail({ RESEND_API_KEY: "k", EMAIL_FROM: "Peregrin <reservations@send.peregrin.travel>", booking: BK, lang: "es",
      links: { page: "https://x/b", cancel: "https://x/c" }, pdf: Buffer.from("pdf") });
    assert.ok(ok);
  } finally { globalThis.fetch = orig; }
  assert.equal(sent.url, "https://api.resend.com/emails");
  assert.equal(sent.body.to, "delivered@resend.dev");
  assert.match(sent.body.subject, /Tu reserva de hotel está confirmada/);
  assert.match(sent.body.html, /https:\/\/x\/c/);
  assert.match(sent.body.html, /Cancelación gratuita hasta 13 Dec 2026, 23:59 UTC/);
  assert.equal(sent.body.attachments[0].filename, "aY2hZCx8Y-hotel-booking.pdf");
});

test("normaliseBooking falls back to lastFreeCancellationDate for the deadline", () => {
  const b = normaliseBooking({ data: { bookingId: "X", status: "CONFIRMED", lastFreeCancellationDate: "2026-12-13T23:59:59Z", cancellationPolicies: { refundableTag: "RFN", cancelPolicyInfos: [] } } });
  assert.equal(b.cancelDeadline, "2026-12-13T23:59:59.000Z");
});
