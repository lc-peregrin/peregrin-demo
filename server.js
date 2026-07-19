import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const DUFFEL_API_KEY = process.env.DUFFEL_API_KEY;
const DUFFEL_BASE = "https://api.duffel.com";
const RESEND_API_KEY = process.env.RESEND_API_KEY; // optional — email sending only works once this is set
const EMAIL_FROM = process.env.EMAIL_FROM || "Peregrin <reservations@peregrin.travel>";

if (!DUFFEL_API_KEY) {
  console.warn("WARNING: DUFFEL_API_KEY is not set. Set it in .env before making live calls.");
}

async function duffel(pathname, options = {}) {
  const res = await fetch(`${DUFFEL_BASE}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${DUFFEL_API_KEY}`,
      "Duffel-Version": "v2",
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error("Duffel API error");
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ---------- Flights: search ----------
app.post("/api/search", async (req, res) => {
  try {
    const { origin, destination, departure_date, return_date, passengers = 1 } = req.body;

    const slices = [{ origin, destination, departure_date }];
    if (return_date) {
      slices.push({ origin: destination, destination: origin, departure_date: return_date });
    }

    const payload = {
      data: {
        slices,
        passengers: Array.from({ length: passengers }, () => ({ type: "adult" })),
        cabin_class: "economy",
      },
    };

    const result = await duffel(`/air/offer_requests?return_offers=true&supplier_timeout=8000`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const offers = (result.data.offers || [])
      // Peregrin only ever holds reservations (never instant-purchase-only fares) —
      // filter out any offer Duffel would reject a "hold" order type for.
      .filter((o) => !o.payment_requirements?.requires_instant_payment)
      .sort((a, b) => parseFloat(a.total_amount) - parseFloat(b.total_amount))
      .slice(0, 6)
      .map((o) => ({
        id: o.id,
        total_amount: o.total_amount,
        total_currency: o.total_currency,
        slices: o.slices.map((s) => ({
          origin: s.origin.iata_code,
          destination: s.destination.iata_code,
          segments: s.segments.map((seg) => ({
            departing_at: seg.departing_at,
            arriving_at: seg.arriving_at,
            airline: seg.marketing_carrier.name,
            flight_number: `${seg.marketing_carrier.iata_code}${seg.marketing_carrier_flight_number}`,
            origin: seg.origin.iata_code,
            destination: seg.destination.iata_code,
          })),
        })),
      }));

    res.json({ offer_request_id: result.data.id, offers });
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// ---------- Flights: create a hold order ----------
app.post("/api/hold", async (req, res) => {
  try {
    const { offer_id, passenger } = req.body;

    const offerResult = await duffel(`/air/offers/${offer_id}?return_available_services=false`);
    const passengerId = offerResult.data.passengers[0].id;

    const payload = {
      data: {
        type: "hold",
        selected_offers: [offer_id],
        passengers: [
          {
            id: passengerId,
            title: passenger.title || "mr",
            given_name: passenger.given_name,
            family_name: passenger.family_name,
            gender: passenger.gender || "m",
            born_on: passenger.born_on,
            email: passenger.email,
            phone_number: passenger.phone_number,
          },
        ],
      },
    };

    const result = await duffel(`/air/orders`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    res.json(formatOrder(result.data));
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// ---------- Flights: fetch order (used for the "verify this reservation" check) ----------
app.get("/api/order/:id", async (req, res) => {
  try {
    const result = await duffel(`/air/orders/${req.params.id}`);
    res.json(formatOrder(result.data));
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// ---------- Flights: confirm & pay (upgrade hold -> real ticketed fare) ----------
// Uses Duffel's test-mode account balance so the demo can show the full
// "confirm before it lapses" flow without needing real card details.
app.post("/api/order/:id/confirm", async (req, res) => {
  try {
    const order = await duffel(`/air/orders/${req.params.id}`);
    const payload = {
      data: {
        order_id: req.params.id,
        payment: {
          type: "balance",
          amount: order.data.total_amount,
          currency: order.data.total_currency,
        },
      },
    };
    await duffel(`/air/payments`, { method: "POST", body: JSON.stringify(payload) });
    const updated = await duffel(`/air/orders/${req.params.id}`);
    res.json(formatOrder(updated.data));
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// ---------- PDF: the actual document a traveller shows at the border ----------
app.get("/api/order/:id/pdf", async (req, res) => {
  try {
    const result = await duffel(`/air/orders/${req.params.id}`);
    const order = formatOrder(result.data);
    const brand = parseBrand(req.query);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${order.booking_reference}-reservation.pdf"`);

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    doc.pipe(res);
    renderReservationPdf(doc, order, brand);
    doc.end();
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// ---------- Email: send the PDF to the traveller ----------
// Sent from Peregrin's own domain — never spoofed to look like it's from an airline.
// Requires RESEND_API_KEY to be set; without it this endpoint explains that clearly
// rather than pretending to have sent anything.
app.post("/api/order/:id/email", async (req, res) => {
  try {
    if (!RESEND_API_KEY) {
      return res.status(501).json({
        error: "Email sending isn't configured yet — set RESEND_API_KEY to enable this.",
      });
    }
    const result = await duffel(`/air/orders/${req.params.id}`);
    const order = formatOrder(result.data);
    const brand = parseBrand(req.body);

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    const pdfBuffer = await new Promise((resolve) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      renderReservationPdf(doc, order, brand);
      doc.end();
    });

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: order.passenger_email,
        subject: `Your reservation ${order.booking_reference} — ${brand.name}`,
        html: `<p>Hi ${order.passenger_name},</p>
<p>Your flight reservation is attached as a PDF, and the booking reference below can be verified directly with the airline.</p>
<p><strong>Booking reference:</strong> ${order.booking_reference}<br/>
<strong>Route:</strong> ${order.route_summary}<br/>
<strong>Hold expires:</strong> ${order.payment_required_by || "N/A"}</p>
<p>— ${brand.name}</p>`,
        attachments: [
          {
            filename: `${order.booking_reference}-reservation.pdf`,
            content: pdfBuffer.toString("base64"),
          },
        ],
      }),
    });

    if (!emailRes.ok) {
      const errBody = await emailRes.json().catch(() => ({}));
      throw Object.assign(new Error("Resend API error"), { status: emailRes.status, body: errBody });
    }

    res.json({ sent: true, to: order.passenger_email });
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// ---------- Stays: accommodation proof-of-booking ----------
// Note: Duffel Stays is a separate product from Duffel Flights and requires its own
// access request (https://duffel.com/contact-us) even after Flights is live. Until
// that's approved, these calls will fail — the frontend surfaces that clearly rather
// than faking a result.
app.post("/api/stays/search", async (req, res) => {
  try {
    const { latitude, longitude, radius = 5, check_in_date, check_out_date, guests = 1 } = req.body;
    const payload = {
      data: {
        rooms: 1,
        location: { radius, geographic_coordinates: { latitude, longitude } },
        check_in_date,
        check_out_date,
        guests: Array.from({ length: guests }, () => ({ type: "adult" })),
      },
    };
    const result = await duffel(`/stays/search`, { method: "POST", body: JSON.stringify(payload) });
    const results = (result.data.results || []).slice(0, 8).map((r) => ({
      search_result_id: r.id,
      name: r.accommodation?.name,
      location: r.accommodation?.location?.address?.city_name,
      cheapest_rate: r.cheapest_rate_total_amount,
      currency: r.cheapest_rate_currency,
      free_cancellation: r.cheapest_rate_refundable,
    }));
    res.json({ results });
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message, stays_access_required: err.status === 403 });
  }
});

app.get("/api/stays/rates/:search_result_id", async (req, res) => {
  try {
    const result = await duffel(`/stays/search_results/${req.params.search_result_id}/actions/fetch_all_rates`, {
      method: "POST",
    });
    res.json(result.data);
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message, stays_access_required: err.status === 403 });
  }
});

app.post("/api/stays/quote", async (req, res) => {
  try {
    const { rate_id } = req.body;
    const result = await duffel(`/stays/quotes`, {
      method: "POST",
      body: JSON.stringify({ data: { rate_id } }),
    });
    res.json(result.data);
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message, stays_access_required: err.status === 403 });
  }
});

app.post("/api/stays/book", async (req, res) => {
  try {
    const { quote_id, guest, email, phone_number } = req.body;
    const payload = {
      data: {
        quote_id,
        email,
        phone_number,
        guests: [{ given_name: guest.given_name, family_name: guest.family_name, born_on: guest.born_on }],
      },
    };
    const result = await duffel(`/stays/bookings`, { method: "POST", body: JSON.stringify(payload) });
    res.json(result.data);
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message, stays_access_required: err.status === 403 });
  }
});

// ---------- helpers ----------
function formatOrder(data) {
  const slice = data.slices?.[0];
  const seg = slice?.segments?.[0];
  const passenger = data.passengers?.[0];
  return {
    order_id: data.id,
    booking_reference: data.booking_reference,
    payment_status: data.payment_status,
    price_guarantee_expires_at: data.payment_status?.price_guarantee_expires_at,
    payment_required_by: data.payment_status?.payment_required_by,
    awaiting_payment: data.payment_status?.awaiting_payment,
    total_amount: data.total_amount,
    total_currency: data.total_currency,
    route_summary: slice ? `${slice.origin?.iata_code} → ${slice.destination?.iata_code}` : "",
    airline: seg?.marketing_carrier?.name,
    flight_number: seg ? `${seg.marketing_carrier?.iata_code}${seg.marketing_carrier_flight_number}` : "",
    departing_at: seg?.departing_at,
    passenger_name: passenger ? `${passenger.given_name} ${passenger.family_name}` : "",
    passenger_email: passenger?.email,
    slices: data.slices,
  };
}

function parseBrand(query) {
  return {
    name: query?.brand_name || "Peregrin",
    accent: query?.brand_color || "#c8622d",
  };
}

function renderReservationPdf(doc, order, brand) {
  doc.fontSize(10).fillColor("#5b6577").text(brand.name.toUpperCase(), { characterSpacing: 1 });
  doc.moveDown(0.5);
  doc.fontSize(22).fillColor("#1a2233").text("Flight Reservation");
  doc.moveDown(1);

  doc.fontSize(11).fillColor("#5b6577").text("Booking reference");
  doc.fontSize(20).fillColor(brand.accent).text(order.booking_reference || "—");
  doc.moveDown(1);

  doc.fontSize(11).fillColor("#5b6577").text("Route");
  doc.fontSize(14).fillColor("#1a2233").text(order.route_summary || "—");
  doc.moveDown(0.5);

  doc.fontSize(11).fillColor("#5b6577").text("Carrier");
  doc.fontSize(14).fillColor("#1a2233").text(`${order.airline || "—"} · ${order.flight_number || ""}`);
  doc.moveDown(0.5);

  doc.fontSize(11).fillColor("#5b6577").text("Passenger");
  doc.fontSize(14).fillColor("#1a2233").text(order.passenger_name || "—");
  doc.moveDown(0.5);

  doc.fontSize(11).fillColor("#5b6577").text("Status");
  doc.fontSize(14).fillColor("#1a2233").text(order.awaiting_payment ? "Held — not yet ticketed" : "Confirmed & ticketed");
  if (order.payment_required_by) {
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor("#5b6577").text("Hold expires");
    doc.fontSize(14).fillColor("#1a2233").text(new Date(order.payment_required_by).toUTCString());
  }

  doc.moveDown(2);
  doc.fontSize(9).fillColor("#5b6577").text(
    "This reservation can be independently verified with the operating carrier using the booking reference above. " +
      "This document does not itself constitute a ticket unless the status above shows Confirmed & ticketed.",
    { width: 480 }
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Peregrin demo running on http://localhost:${PORT}`));
