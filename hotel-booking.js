// On-site hotel booking (LiteAPI / Nuitee Connect): JSON API + booking pages.
//
// Flow: /hotels search -> pick a rate -> guest details -> /api/hotels/prebook
// (usePaymentSdk) -> LiteAPI payment SDK takes the card (Peregrin never sees
// it) -> SDK redirects to /hotels/complete -> /api/hotels/book with the
// transactionId -> signed confirmation page, PDF and email -> self-serve cancel.
//
// No database. LiteAPI is the store: every booking page re-reads the booking
// from LiteAPI, and pages are reachable only via an HMAC-signed link.

import {
  lite, liteConfigured, isSandbox, HOTEL_MARGIN_PCT,
  normaliseRates, normalisePrebook, normaliseBooking, normaliseCancel, signBooking, verifyBooking,
} from "./liteapi.js";
import { renderHotelPdf, utcStamp } from "./hotel-pdf.js";
import { HOTELS_PATHS, HOTELS_COPY, renderBookingPage, renderCompletePage, renderCancelPage } from "./hotels.js";

const LANGS = ["en", "es", "ru", "hi"];
const pickLang = (v) => (LANGS.includes(v) ? v : "en");
const ymd = /^\d{4}-\d{2}-\d{2}$/;

function bookingLinks(origin, id, lang) {
  const t = signBooking(id);
  const q = `t=${encodeURIComponent(t)}${lang && lang !== "en" ? `&lang=${lang}` : ""}`;
  return {
    page: `${origin}/hotels/booking/${encodeURIComponent(id)}?${q}`,
    pdf: `${origin}/hotels/booking/${encodeURIComponent(id)}/pdf?t=${encodeURIComponent(t)}`,
    cancel: `${origin}/hotels/booking/${encodeURIComponent(id)}/cancel?${q}`,
  };
}

async function pdfBuffer(getPdfDeps, bk) {
  const { PDFDocument } = await getPdfDeps();
  const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: "Hotel booking confirmation" } });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  return new Promise((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    renderHotelPdf(doc, bk);
    doc.end();
  });
}

const escH = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function registerHotelBooking(app, { SITE_ORIGIN, ANALYTICS_TAG, getPdfDeps, RESEND_API_KEY, EMAIL_FROM }) {
  const notConfigured = (res) => res.status(501).json({ error: "Hotel booking isn't configured." });

  app.get("/api/hotels/places", async (req, res) => {
    if (!liteConfigured()) return notConfigured(res);
    const q = String(req.query.q || "").trim().slice(0, 80);
    if (q.length < 2) return res.json({ places: [] });
    try {
      const r = await lite.places(q, pickLang(req.query.lang));
      res.json({ places: (r.data || []).slice(0, 8).map((p) => ({ id: p.placeId, name: p.displayName, detail: p.formattedAddress || "", types: p.types || [] })) });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.post("/api/hotels/search", async (req, res) => {
    if (!liteConfigured()) return notConfigured(res);
    const { placeId, checkin, checkout } = req.body || {};
    const adults = Math.min(Math.max(parseInt(req.body?.adults, 10) || 1, 1), 4);
    if (!placeId || !ymd.test(checkin || "") || !ymd.test(checkout || "") || checkout <= checkin) {
      return res.status(400).json({ error: "Choose a destination and valid dates." });
    }
    try {
      const r = await lite.rates({
        placeId: String(placeId), checkin, checkout,
        occupancies: [{ adults }],
        currency: "USD",
        guestNationality: String(req.body?.nationality || "US").toUpperCase().slice(0, 2),
        margin: HOTEL_MARGIN_PCT,
        limit: 40, maxRatesPerHotel: 12, includeHotelData: true, timeout: 15,
      });
      res.json({ hotels: normaliseRates(r), sandbox: isSandbox() });
    } catch (err) {
      // "No availability" comes back as an error from LiteAPI; it is not a failure.
      if (err.status === 200 || /no availability|not found/i.test(err.message)) return res.json({ hotels: [], sandbox: isSandbox() });
      res.status(502).json({ error: err.message });
    }
  });

  app.post("/api/hotels/prebook", async (req, res) => {
    if (!liteConfigured()) return notConfigured(res);
    const offerId = String(req.body?.offerId || "");
    if (!offerId) return res.status(400).json({ error: "Missing offer." });
    try {
      const p = normalisePrebook(await lite.prebook(offerId));
      res.json({ ...p, sandbox: isSandbox() });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.post("/api/hotels/book", async (req, res) => {
    if (!liteConfigured()) return notConfigured(res);
    const b = req.body || {};
    const g = b.guest || {};
    const lang = pickLang(b.lang);
    const clean = (s, n = 60) => String(s || "").trim().slice(0, n);
    const firstName = clean(g.firstName), lastName = clean(g.lastName), email = clean(g.email, 120), phone = clean(g.phone, 30);
    if (!b.prebookId || !b.transactionId || !firstName || !lastName || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: "Missing booking details." });
    }
    let booking;
    try {
      const r = await lite.book({
        prebookId: String(b.prebookId),
        holder: { firstName, lastName, email, phone },
        payment: { method: "TRANSACTION_ID", transactionId: String(b.transactionId) },
        guests: [{ occupancyNumber: 1, firstName, lastName, email, phone }],
        clientReference: `peregrin-${Date.now()}`,
      });
      booking = normaliseBooking(r);
      if (!booking.bookingId) throw Object.assign(new Error("No booking id returned"), { status: 502 });
    } catch (err) {
      return res.status(err.status && err.status < 500 ? 400 : 502).json({ error: err.message });
    }
    // The book response can omit hotel details; re-read for the full record.
    try { booking = { ...booking, ...pick(normaliseBooking(await lite.booking(booking.bookingId))) }; } catch { /* keep book response */ }
    booking = await withAddress(booking);
    const links = bookingLinks(SITE_ORIGIN, booking.bookingId, lang); // absolute, for the email
    const local = bookingLinks("", booking.bookingId, lang); // relative, for this site
    let emailed = false;
    if (RESEND_API_KEY && booking.email) {
      try {
        const pdf = await pdfBuffer(getPdfDeps, booking);
        emailed = await sendConfirmationEmail({ RESEND_API_KEY, EMAIL_FROM, booking, links, lang, pdf });
      } catch (err) {
        console.error("hotel confirmation email failed:", err.message);
      }
    }
    res.json({ bookingId: booking.bookingId, status: booking.status, refundable: booking.refundable, url: local.page, emailed });
  });

  // Signed-link guard for every booking page.
  async function loadBooking(req, res) {
    if (!liteConfigured()) { res.status(501).send("Hotel booking isn't configured."); return null; }
    const id = req.params.id;
    if (!verifyBooking(id, req.query.t || req.body?.t)) { res.status(404).type("text").send("Booking not found."); return null; }
    try {
      return await withAddress(normaliseBooking(await lite.booking(id)));
    } catch (err) {
      res.status(502).type("text").send("We couldn't load this booking just now. Please try again in a moment.");
      return null;
    }
  }

  app.get("/hotels/complete", (req, res) => {
    const lang = pickLang(req.query.lang);
    res.type("html").set("Cache-Control", "no-store").send(renderCompletePage({ lang, headExtra: ANALYTICS_TAG }));
  });

  app.get("/hotels/booking/:id", async (req, res) => {
    const bk = await loadBooking(req, res);
    if (!bk) return;
    const lang = pickLang(req.query.lang);
    res.type("html").set("Cache-Control", "no-store").set("X-Robots-Tag", "noindex")
      .send(renderBookingPage({ lang, bk, links: bookingLinks("", bk.bookingId, lang), headExtra: ANALYTICS_TAG }));
  });

  app.get("/hotels/booking/:id/pdf", async (req, res) => {
    const bk = await loadBooking(req, res);
    if (!bk) return;
    const buf = await pdfBuffer(getPdfDeps, bk);
    res.type("application/pdf").set("Content-Disposition", `inline; filename="${bk.bookingId}-hotel-booking.pdf"`).send(buf);
  });

  app.get("/hotels/booking/:id/cancel", async (req, res) => {
    const bk = await loadBooking(req, res);
    if (!bk) return;
    const lang = pickLang(req.query.lang);
    res.type("html").set("Cache-Control", "no-store").set("X-Robots-Tag", "noindex")
      .send(renderCancelPage({ lang, bk, links: bookingLinks("", bk.bookingId, lang), t: req.query.t, headExtra: ANALYTICS_TAG }));
  });

  app.post("/api/hotels/booking/:id/cancel", async (req, res) => {
    if (!liteConfigured()) return notConfigured(res);
    const id = req.params.id;
    if (!verifyBooking(id, req.body?.t)) return res.status(404).json({ error: "Booking not found." });
    try {
      res.json(normaliseCancel(await lite.cancel(id)));
    } catch (err) {
      res.status(err.status && err.status < 500 ? 400 : 502).json({ error: err.message });
    }
  });

  return { HOTELS_PATHS };
}

// The booking record carries no hotel address; it comes from hotel details.
// Cached per hotel; a failure just leaves the address blank.
const _addr = new Map();
async function withAddress(bk) {
  if (bk.hotelAddress || !bk.hotelId) return bk;
  if (!_addr.has(bk.hotelId)) {
    try {
      const h = (await lite.hotel(bk.hotelId)).data || {};
      _addr.set(bk.hotelId, { address: [h.address, h.city, h.country && String(h.country).toUpperCase()].filter(Boolean).join(", "), name: h.name || "" });
    } catch { return bk; }
  }
  const a = _addr.get(bk.hotelId);
  return { ...bk, hotelAddress: a.address, hotelName: bk.hotelName || a.name };
}

// Keep only fields that carry a value, so a sparse re-read can't blank out
// what the book response already gave us.
function pick(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v != null && !(typeof v === "number" && Number.isNaN(v))));
}

export async function sendConfirmationEmail({ RESEND_API_KEY, EMAIL_FROM, booking, links, lang, pdf }) {
  const t = (HOTELS_COPY[lang] || HOTELS_COPY.en).email;
  const lines = [
    `<p>${escH(t.hi)} ${escH(booking.guestName)},</p>`,
    `<p>${escH(t.intro)}</p>`,
    `<p><strong>${escH(booking.hotelName)}</strong><br/>${escH(booking.hotelAddress)}</p>`,
    `<p>${escH(t.dates)}: ${escH(booking.checkin)} &rarr; ${escH(booking.checkout)}<br/>`,
    `${escH(t.ref)}: <strong>${escH(booking.bookingId)}</strong>${booking.hotelConfirmationCode ? ` (${escH(t.hotelRef)}: ${escH(booking.hotelConfirmationCode)})` : ""}<br/>`,
    `${escH(t.status)}: ${escH(t.confirmed)}</p>`,
    `<p>${escH(booking.refundable && booking.cancelDeadline ? t.refundable.replace("{d}", utcStamp(booking.cancelDeadline)) : booking.refundable ? "" : t.nonRefundable)}</p>`,
    `<p><a href="${links.page}">${escH(t.view)}</a>${booking.refundable ? ` &middot; <a href="${links.cancel}">${escH(t.cancel)}</a>` : ""}</p>`,
    `<p>Peregrin</p>`,
  ];
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: booking.email,
      subject: `${t.subject}: ${booking.hotelName} (${booking.bookingId})`,
      html: lines.join("\n"),
      attachments: [{ filename: `${booking.bookingId}-hotel-booking.pdf`, content: pdf.toString("base64") }],
    }),
  });
  return r.ok;
}
