import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";
import Stripe from "stripe";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const DUFFEL_API_KEY = process.env.DUFFEL_API_KEY;
const DUFFEL_BASE = "https://api.duffel.com";
const RESEND_API_KEY = process.env.RESEND_API_KEY; // optional — email sending only works once this is set
// Must be an address on the verified *sending* domain (send.peregrin.travel) —
// peregrin.travel itself was left unverified in Resend on purpose, to avoid
// touching the root domain's existing Google Workspace DKIM/DMARC records.
const EMAIL_FROM = process.env.EMAIL_FROM || "Peregrin <reservations@send.peregrin.travel>";

// Stripe collects real money from the *customer*; Duffel's balance is what Peregrin
// then pays the *airline* with. These are two separate legs of the same transaction —
// see payOrderWithDuffelBalance() and the /api/stripe/webhook route below.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// ---------- Peregrin's own retail pricing for the HOLD product ----------
// This is what the customer pays *Peregrin* for the held reservation and its
// document — it is NOT the airline fare. Most customers never proceed to a real
// ticket, so this fee is the actual product (docs/BUSINESS_PLAN.md §1, §3).
//
// CURRENCY NOTE: the Duffel account is AUD-denominated, so offer/fare amounts
// come back as AUD. This fee is deliberately priced and charged in USD because
// §3 benchmarks it against USD-priced competitors (onwardticket.com at $16 flat).
// That means the hold fee (USD) and the optional confirm-to-fly fare (AUD) are
// charged in different currencies — flagged for Liam in NOTES-FOR-LIAM.md, and
// changeable here in one place if he'd rather align them.
const HOLD_FEE_CURRENCY = process.env.HOLD_FEE_CURRENCY || "USD";
const HOLD_FEE_STANDARD = Number(process.env.HOLD_FEE_STANDARD || 14.99);
const HOLD_FEE_MULTI = Number(process.env.HOLD_FEE_MULTI || 19.99);

// One flat, all-in price — no itemised "service fee" line and no card surcharge.
// That's both the best-converting pattern and the only cleanly compliant one in
// the EU and Australia (docs/BUSINESS_PLAN.md §9).
function holdFeeForSliceCount(sliceCount) {
  return sliceCount > 1 ? HOLD_FEE_MULTI : HOLD_FEE_STANDARD;
}

if (!DUFFEL_API_KEY) {
  console.warn("WARNING: DUFFEL_API_KEY is not set. Set it in .env before making live calls.");
}
if (!stripe) {
  console.warn("WARNING: STRIPE_SECRET_KEY is not set. /api/order/:id/checkout will return 501 until it is.");
}

// The Stripe webhook needs the *raw* request body to verify its signature, so this
// route (and its own express.raw() body parser) must be registered before the global
// express.json() below — Express matches routes in registration order, so this one
// claims the request first and the JSON parser never touches it.
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    console.warn("Stripe webhook received but STRIPE_WEBHOOK_SECRET is not configured — ignoring.");
    return res.status(501).send("Stripe webhook not configured");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orderId = session.metadata?.order_id;
    // Two DIFFERENT products can be paid for against the same order, and they must
    // never be conflated:
    //   purpose "hold_fee" -> customer bought the held reservation + its document.
    //                         Peregrin keeps this. The airline is NOT paid, and the
    //                         hold still lapses on its own if never confirmed.
    //   purpose "fare"     -> customer chose to actually fly, so Peregrin now pays
    //                         the airline via Duffel balance to issue a real ticket.
    // Sessions created before this split carry no `purpose`; those were all fare
    // payments, so an absent purpose intentionally falls through to the fare path.
    const purpose = session.metadata?.purpose || "fare";
    if (orderId) {
      if (purpose === "hold_fee") {
        markHoldFeePaid(orderId);
        console.log(`Hold fee paid for order ${orderId} (Stripe ${session.id}) — document unlocked, airline NOT paid.`);
      } else {
        try {
          // Customer has genuinely paid Peregrin via Stripe at this point. Peregrin now
          // pays the airline via Duffel's balance to actually ticket the reservation —
          // this mirrors the real production flow (customer -> Peregrin -> airline).
          await payOrderWithDuffelBalance(orderId);
          console.log(`Order ${orderId} ticketed with Duffel after Stripe payment ${session.id}.`);
        } catch (err) {
          // The customer has already been charged at this point, so we don't fail the
          // webhook response — but this needs visibility/retry in a real deployment
          // (e.g. an alert or a queue), not just a log line.
          console.error(`Failed to ticket Duffel order ${orderId} after Stripe payment:`, err.body || err);
        }
      }
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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
  // Duffel usually returns JSON, but some rejections (e.g. a product like Stays
  // not being enabled for the account) come back as plain text — parse defensively
  // so those don't get swallowed as a generic 500.
  const raw = await res.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { message: raw };
  }
  if (!res.ok) {
    const err = new Error("Duffel API error");
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ---------- Hold-fee entitlement ----------
// Which orders have had their hold fee paid, so the document can be released.
// This in-process cache is only a fast path: on Vercel each invocation can be a
// fresh instance, so it is NOT durable. The authoritative check is asking Stripe
// directly about the Checkout Session the customer came back with, which is
// stateless and works regardless of which instance serves the request.
// A real deployment should persist this in a datastore — see NOTES-FOR-LIAM.md.
const paidHoldOrders = new Set();

function markHoldFeePaid(orderId) {
  paidHoldOrders.add(orderId);
}

// An order's document is released when EITHER the hold fee has been paid, OR the
// order is already ticketed (the customer paid the full fare via the
// confirm-to-fly path, which obviously also entitles them to the document).
async function hasDocumentAccess(orderId, sessionId, order) {
  if (paidHoldOrders.has(orderId)) return true;
  if (order && order.awaiting_payment === false) return true;
  if (!sessionId || !stripe) return false;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (
      session.payment_status === "paid" &&
      session.metadata?.order_id === orderId &&
      session.metadata?.purpose === "hold_fee"
    ) {
      markHoldFeePaid(orderId);
      return true;
    }
  } catch (err) {
    console.warn(`Could not verify Stripe session ${sessionId}:`, err.message);
  }
  return false;
}

// Peregrin's own price list, exposed so the frontend never hardcodes a number.
app.get("/api/pricing", (req, res) => {
  res.json({
    currency: HOLD_FEE_CURRENCY,
    standard: HOLD_FEE_STANDARD,
    multi: HOLD_FEE_MULTI,
  });
});

// ---------- Places: airport / city type-ahead ----------
// Backed by Duffel's own Places Suggestions dataset, so there's no separate
// airport database to license or keep current. Proxied through the server so
// the Duffel API key never reaches the browser.
app.get("/api/places", async (req, res) => {
  try {
    const query = (req.query.query || "").trim();
    if (query.length < 2) return res.json({ places: [] });
    const result = await duffel(`/places/suggestions?query=${encodeURIComponent(query)}`);
    const places = (result.data || [])
      // Only places that can actually be used as a slice origin/destination.
      .filter((p) => p.iata_code)
      .slice(0, 8)
      .map((p) => ({
        iata_code: p.iata_code,
        name: p.name,
        city_name: p.city_name || p.city?.name || null,
        country_code: p.iata_country_code || null,
        type: p.type || null,
      }));
    res.json({ places });
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// Duffel wants one passenger object per traveller. Ages matter to pricing and
// to what the airline will allow, so the three UI categories map onto Duffel's
// own passenger types rather than being collapsed into a single head count.
//   adult  -> { type: "adult" }              (12+)
//   child  -> { type: "child" }              (2-11)
//   infant -> { type: "infant_without_seat" } (under 2, on an adult's lap)
function buildPassengers({ adults, children, infants, passengers }) {
  // Back-compat: older callers (and the API tests) send a plain adult count.
  if (adults == null && children == null && infants == null) {
    return Array.from({ length: Math.max(1, Number(passengers) || 1) }, () => ({ type: "adult" }));
  }
  const list = [];
  for (let i = 0; i < Number(adults || 0); i++) list.push({ type: "adult" });
  for (let i = 0; i < Number(children || 0); i++) list.push({ type: "child" });
  for (let i = 0; i < Number(infants || 0); i++) list.push({ type: "infant_without_seat" });
  return list.length ? list : [{ type: "adult" }];
}

// ---------- Flights: search ----------
app.post("/api/search", async (req, res) => {
  try {
    const { origin, destination, departure_date, return_date, passengers = 1, adults, children, infants } = req.body;

    const slices = [{ origin, destination, departure_date }];
    if (return_date) {
      slices.push({ origin: destination, destination: origin, departure_date: return_date });
    }

    const payload = {
      data: {
        slices,
        passengers: buildPassengers({ adults, children, infants, passengers }),
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
// The offer was priced for whatever passenger mix the customer searched (see the
// stepper in index.html), so Duffel requires exactly one passenger object per
// offer passenger — one traveller's details each, matched by type. We collect a
// name + date of birth per traveller and reuse the lead's email/phone as contact.
app.post("/api/hold", async (req, res) => {
  try {
    const { offer_id, passengers, passenger, email, phone_number } = req.body;

    // Back-compat: older callers (and the API tests) send a single `passenger`.
    const travellers = Array.isArray(passengers) && passengers.length ? passengers : passenger ? [passenger] : [];
    const contactEmail = email || travellers[0]?.email;
    const contactPhone = phone_number || travellers[0]?.phone_number || "+61400000000";

    const offerResult = await duffel(`/air/offers/${offer_id}?return_available_services=false`);
    const offerPassengers = offerResult.data.passengers || [];

    // Queue up the collected travellers by type so each offer passenger (which
    // carries its own type) gets a matching person; fall back across types if the
    // counts don't line up, so we never send a malformed order.
    const byType = {};
    travellers.forEach((t) => {
      const type = t.type || "adult";
      (byType[type] = byType[type] || []).push(t);
    });
    const anyLeft = () => Object.values(byType).find((q) => q.length);
    const takeFor = (type) => (byType[type] && byType[type].length ? byType[type].shift() : (anyLeft() || []).shift());

    const payloadPassengers = offerPassengers.map((op) => {
      const t = takeFor(op.type) || {};
      return {
        id: op.id,
        title: t.title || "mr",
        given_name: t.given_name,
        family_name: t.family_name,
        gender: t.gender || "m",
        born_on: t.born_on,
        email: contactEmail,
        phone_number: contactPhone,
      };
    });

    const payload = { data: { type: "hold", selected_offers: [offer_id], passengers: payloadPassengers } };

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

// Pays the airline (via Duffel's account balance) to actually ticket a held order.
// Shared by the manual "Confirm & pay" demo button and the Stripe webhook — in a real
// deployment this is the step that spends Peregrin's own money to fulfil an order a
// customer has already paid Peregrin for.
async function payOrderWithDuffelBalance(orderId) {
  const order = await duffel(`/air/orders/${orderId}`);
  const payload = {
    data: {
      order_id: orderId,
      payment: {
        type: "balance",
        amount: order.data.total_amount,
        currency: order.data.total_currency,
      },
    },
  };
  await duffel(`/air/payments`, { method: "POST", body: JSON.stringify(payload) });
  const updated = await duffel(`/air/orders/${orderId}`);
  return formatOrder(updated.data);
}

// ---------- Flights: confirm & pay (upgrade hold -> real ticketed fare) ----------
// Uses Duffel's test-mode account balance so the demo can show the full
// "confirm before it lapses" flow without needing real card details. This is the
// internal/demo path; /api/order/:id/checkout below is the real customer-facing one.
app.post("/api/order/:id/confirm", async (req, res) => {
  try {
    res.json(await payOrderWithDuffelBalance(req.params.id));
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// ---------- Payments: the HOLD FEE — Peregrin's actual product ----------
// Charges the customer for the held reservation and its document. This does NOT
// pay the airline and does NOT ticket anything: the hold still lapses on its own
// if the customer never confirms. Deliberately a separate route and a separate
// Stripe `purpose` from /checkout below, which is the "I actually want to fly"
// fare payment — the two must not be conflated.
app.post("/api/order/:id/hold-checkout", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(501).json({
        error: "Payments aren't configured yet — set STRIPE_SECRET_KEY to enable this.",
      });
    }
    const result = await duffel(`/air/orders/${req.params.id}`);
    const order = formatOrder(result.data);
    const brand = parseBrand(req.body);
    const amount = order.hold_fee;
    const origin = `${req.protocol}://${req.get("host")}`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: HOLD_FEE_CURRENCY.toLowerCase(),
            unit_amount: Math.round(amount * 100),
            product_data: {
              name: `${order.hold_fee_label} — ${order.route_summary}`,
              description:
                `${brand.name}: a real, verifiable reservation held with the airline (booking reference ` +
                `${order.booking_reference}), with a PDF you can show at check-in, immigration, or with a visa ` +
                `application. This is a held reservation, not a purchased ticket.`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        order_id: req.params.id,
        purpose: "hold_fee",
        brand_name: brand.name,
        brand_color: brand.accent,
      },
      success_url: `${origin}/?hold_paid_order_id=${req.params.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?hold_checkout_cancelled=1`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// Lets the frontend ask whether a document is unlocked yet (used on return from
// Stripe, and to decide whether to show the pay button or the download buttons).
app.get("/api/order/:id/document-access", async (req, res) => {
  try {
    const result = await duffel(`/air/orders/${req.params.id}`);
    const order = formatOrder(result.data);
    const unlocked = await hasDocumentAccess(req.params.id, req.query.session_id, order);
    res.json({ unlocked, hold_fee: order.hold_fee, hold_fee_currency: order.hold_fee_currency });
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// ---------- Payments: create a Stripe Checkout session for a real customer payment ----------
// This is the path an actual traveller uses to pay Peregrin. Once Stripe confirms the
// payment (via the webhook above), Peregrin pays the airline through Duffel in turn.
app.post("/api/order/:id/checkout", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(501).json({
        error: "Payments aren't configured yet — set STRIPE_SECRET_KEY to enable this.",
      });
    }
    const result = await duffel(`/air/orders/${req.params.id}`);
    const order = formatOrder(result.data);
    const brand = parseBrand(req.body);
    const amount = parseFloat(order.total_amount);
    if (!order.total_amount || Number.isNaN(amount)) {
      return res.status(400).json({ error: "This order has no payable amount." });
    }
    const origin = `${req.protocol}://${req.get("host")}`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: (order.total_currency || "usd").toLowerCase(),
            unit_amount: Math.round(amount * 100),
            product_data: {
              name: `Flight reservation ${order.booking_reference} — ${order.route_summary}`,
              description: `${brand.name}: verifiable flight reservation, booking reference ${order.booking_reference}`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        order_id: req.params.id,
        // Explicit so the webhook can tell this apart from a hold-fee payment.
        purpose: "fare",
        brand_name: brand.name,
        brand_color: brand.accent,
      },
      success_url: `${origin}/?paid_order_id=${req.params.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout_cancelled=1`,
    });

    res.json({ url: session.url });
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

    // The document is the product — release it only once it's been paid for
    // (or the order is already ticketed via the confirm-to-fly path).
    if (!(await hasDocumentAccess(req.params.id, req.query.session_id, order))) {
      return res.status(402).json({
        error: "payment_required",
        message: "This reservation's document hasn't been paid for yet.",
        hold_fee: order.hold_fee,
        hold_fee_currency: order.hold_fee_currency,
      });
    }

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

    // Same gate as the PDF download — the emailed document is the same product.
    if (!(await hasDocumentAccess(req.params.id, req.body?.session_id, order))) {
      return res.status(402).json({
        error: "payment_required",
        message: "This reservation's document hasn't been paid for yet.",
        hold_fee: order.hold_fee,
        hold_fee_currency: order.hold_fee_currency,
      });
    }

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

// Duffel segment timestamps are ISO 8601 with the *local* UTC offset of that airport
// (e.g. "2026-08-15T20:15:00+07:00"). We want to display the wall-clock time at that
// airport, so we read the date/time digits straight out of the string rather than
// letting `Date` re-interpret them in the server's own timezone.
function formatLocalDateTime(iso) {
  if (!iso) return { date: "", time: "" };
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return { date: "", time: "" };
  const [, y, mo, d, h, mi] = m;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const weekday = days[new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay()];
  return { date: `${weekday}, ${+d} ${months[+mo - 1]} ${y}`, time: `${h}:${mi}` };
}

// For duration math (same-segment or gap-between-segments) the offsets make `Date`
// arithmetic safe even though display formatting above avoids `Date` entirely.
function formatDuration(ms) {
  if (ms == null || ms < 0) return "";
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function buildItinerary(rawSlices) {
  return (rawSlices || []).map((slice) => ({
    origin: slice.origin?.iata_code || "",
    destination: slice.destination?.iata_code || "",
    segments: (slice.segments || []).map((seg, i, arr) => {
      const dep = formatLocalDateTime(seg.departing_at);
      const arv = formatLocalDateTime(seg.arriving_at);
      const durationMs =
        seg.departing_at && seg.arriving_at ? new Date(seg.arriving_at) - new Date(seg.departing_at) : null;
      const next = arr[i + 1];
      let layover = null;
      if (next && seg.arriving_at && next.departing_at) {
        const layoverMs = new Date(next.departing_at) - new Date(seg.arriving_at);
        layover = { airport: seg.destination?.iata_code || "", label: formatDuration(layoverMs) };
      }
      return {
        flight_number: `${seg.marketing_carrier?.iata_code || ""}${seg.marketing_carrier_flight_number || ""}`.trim(),
        airline: seg.marketing_carrier?.name || "",
        aircraft: seg.aircraft?.name || "",
        origin_iata: seg.origin?.iata_code || "",
        origin_name: seg.origin?.city_name || seg.origin?.name || "",
        destination_iata: seg.destination?.iata_code || "",
        destination_name: seg.destination?.city_name || seg.destination?.name || "",
        departure_date: dep.date,
        departure_time: dep.time,
        arrival_date: arv.date,
        arrival_time: arv.time,
        duration: formatDuration(durationMs),
        layover_after: layover,
      };
    }),
  }));
}

function formatOrder(data) {
  const slice = data.slices?.[0];
  const seg = slice?.segments?.[0];
  const passenger = data.passengers?.[0];
  // A return/multi-city itinerary is more segments and a second Duffel order fee,
  // so it carries the higher price (docs/BUSINESS_PLAN.md §3).
  const sliceCount = data.slices?.length || 1;
  const isMulti = sliceCount > 1;
  return {
    order_id: data.id,
    hold_fee: holdFeeForSliceCount(sliceCount),
    hold_fee_currency: HOLD_FEE_CURRENCY,
    hold_fee_label: isMulti ? "Return / multi-city reservation hold" : "Reservation hold",
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
    passenger_names: (data.passengers || []).map((p) => `${p.given_name} ${p.family_name}`.trim()).filter(Boolean),
    passenger_count: (data.passengers || []).length,
    slices: data.slices,
    itinerary: buildItinerary(data.slices),
  };
}

function parseBrand(query) {
  return {
    name: query?.brand_name || "Peregrin",
    accent: query?.brand_color || "#1c6f8c",
  };
}

// Small vector wing mark echoing the site's header icon — drawn with paths rather
// than an embedded image so the PDF has no external asset dependency.
function drawWingMark(doc, x, y, accent) {
  doc.save();
  doc.lineWidth(2.2).lineCap("round");
  doc.strokeColor(accent).opacity(1)
    .moveTo(x, y + 11).bezierCurveTo(x + 3, y + 9, x + 6, y + 5, x + 7.5, y).stroke();
  doc.strokeColor(accent).opacity(0.55)
    .moveTo(x + 3, y + 12.5).bezierCurveTo(x + 6.5, y + 10.5, x + 9.5, y + 6, x + 11, y + 1).stroke();
  doc.strokeColor("#c9922e").opacity(1)
    .moveTo(x + 6, y + 14).bezierCurveTo(x + 9.5, y + 12, x + 12.5, y + 7.5, x + 14, y + 2).stroke();
  doc.restore();
}

function drawCheck(doc, cx, cy, color) {
  doc.save();
  doc.lineWidth(1.6).lineCap("round").lineJoin("round").strokeColor(color);
  doc.moveTo(cx - 4, cy).lineTo(cx - 1, cy + 3.2).lineTo(cx + 4.5, cy - 4).stroke();
  doc.restore();
}

const PDF_INK = "#16283a";
const PDF_MUTED = "#5c6b7c";
const PDF_LINE = "#d8dee5";

function renderReservationPdf(doc, order, brand) {
  const left = 50;
  const right = 545;
  const width = right - left;
  const held = order.awaiting_payment !== false;

  // ---- Header: brand mark + title, booking reference top-right ----
  drawWingMark(doc, left, 48, brand.accent);
  doc.fontSize(10.5).fillColor(PDF_INK).font("Helvetica-Bold")
    .text(brand.name.toUpperCase(), left + 22, 50, { characterSpacing: 0.8 });

  doc.font("Helvetica").fontSize(9).fillColor(PDF_MUTED)
    .text("Booking reference", left, 50, { width, align: "right" });
  doc.font("Helvetica-Bold").fontSize(16).fillColor(brand.accent)
    .text(order.booking_reference || "—", left, 62, { width, align: "right" });

  doc.moveDown(2);
  doc.font("Helvetica-Bold").fontSize(21).fillColor(PDF_INK).text("Flight Reservation", left, 90);

  // ---- Status banner ----
  const bannerY = doc.y + 14;
  const bannerH = 46;
  const bannerBg = held ? "#e7f4ee" : "#eaf1fb";
  const bannerBorder = held ? "#c3e2d1" : "#c3d7f2";
  const bannerText = held ? "Reservation held" : "Confirmed & ticketed";
  const bannerSub = held
    ? "A real reservation is on hold with the airline. No ticket has been issued yet."
    : "This reservation has been paid and ticketed with the airline.";
  doc.roundedRect(left, bannerY, width, bannerH, 8).fillAndStroke(bannerBg, bannerBorder);
  drawCheck(doc, left + 22, bannerY + bannerH / 2, held ? "#1f7a5c" : "#2a5fa5");
  doc.fillColor(PDF_INK).font("Helvetica-Bold").fontSize(12.5)
    .text(bannerText, left + 40, bannerY + 9, { width: width - 60 });
  doc.fillColor(PDF_MUTED).font("Helvetica").fontSize(9.5)
    .text(bannerSub, left + 40, bannerY + 25, { width: width - 60 });
  doc.y = bannerY + bannerH + 22;

  // ---- Itinerary ----
  doc.font("Helvetica-Bold").fontSize(10).fillColor(brand.accent)
    .text("ITINERARY", left, doc.y, { characterSpacing: 0.8 });
  doc.moveDown(0.6);

  const itinerary = order.itinerary && order.itinerary.length ? order.itinerary : [];
  const sliceLabel = (i) => (itinerary.length > 1 ? (i === 0 ? "Outbound" : "Return") : null);

  itinerary.forEach((slice, sliceIdx) => {
    const label = sliceLabel(sliceIdx);
    if (label) {
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(PDF_MUTED)
        .text(label.toUpperCase(), left, doc.y, { characterSpacing: 0.6 });
      doc.moveDown(0.4);
    }
    slice.segments.forEach((seg, segIdx) => {
      const boxTop = doc.y;
      const padX = 16;
      const padTop = 14;
      let y = boxTop + padTop;

      // Flight number / airline / aircraft
      doc.font("Helvetica-Bold").fontSize(10.5).fillColor(PDF_INK)
        .text(`${seg.flight_number}  ·  ${seg.airline}`, left + padX, y, { width: width - padX * 2 });
      y = doc.y + 2;
      if (seg.aircraft) {
        doc.font("Helvetica").fontSize(8.5).fillColor(PDF_MUTED)
          .text(seg.aircraft, left + padX, y, { width: width - padX * 2 });
        y = doc.y + 6;
      } else {
        y += 6;
      }

      // Origin / destination two-column block with a connecting line
      const colWidth = (width - padX * 2) * 0.4;
      const rowY = y;
      doc.font("Helvetica-Bold").fontSize(15).fillColor(PDF_INK)
        .text(seg.origin_iata, left + padX, rowY, { width: colWidth });
      const leftAfterIata = doc.y;
      doc.font("Helvetica-Bold").fontSize(15).fillColor(PDF_INK)
        .text(seg.destination_iata, left + width - padX - colWidth, rowY, { width: colWidth, align: "right" });
      const rightAfterIata = doc.y;

      let ly = Math.max(leftAfterIata, rightAfterIata) + 1;
      doc.font("Helvetica").fontSize(9).fillColor(PDF_MUTED)
        .text(seg.origin_name, left + padX, ly, { width: colWidth });
      const leftAfterName = doc.y;
      doc.font("Helvetica").fontSize(9).fillColor(PDF_MUTED)
        .text(seg.destination_name, left + width - padX - colWidth, ly, { width: colWidth, align: "right" });
      const rightAfterName = doc.y;

      ly = Math.max(leftAfterName, rightAfterName) + 3;
      doc.font("Helvetica").fontSize(9).fillColor(PDF_INK)
        .text(`${seg.departure_date}  ${seg.departure_time}`, left + padX, ly, { width: colWidth });
      const leftAfterTime = doc.y;
      doc.font("Helvetica").fontSize(9).fillColor(PDF_INK)
        .text(`${seg.arrival_date}  ${seg.arrival_time}`, left + width - padX - colWidth, ly, {
          width: colWidth,
          align: "right",
        });
      const rightAfterTime = doc.y;

      // Connecting line + duration, vertically centered on the IATA-code row
      const lineY = rowY + 8;
      const lineStartX = left + padX + colWidth + 6;
      const lineEndX = left + width - padX - colWidth - 6;
      if (lineEndX > lineStartX) {
        doc.save().lineWidth(1).dash(2, { space: 2 }).strokeColor(PDF_LINE)
          .moveTo(lineStartX, lineY).lineTo(lineEndX, lineY).stroke().undash().restore();
        // arrowhead
        doc.save().fillColor(PDF_LINE)
          .moveTo(lineEndX, lineY - 3).lineTo(lineEndX + 5, lineY).lineTo(lineEndX, lineY + 3).fill().restore();
        if (seg.duration) {
          doc.font("Helvetica").fontSize(8).fillColor(PDF_MUTED)
            .text(seg.duration, lineStartX, lineY - 14, { width: lineEndX - lineStartX, align: "center" });
        }
      }

      const boxBottom = Math.max(leftAfterTime, rightAfterTime) + padTop;
      doc.roundedRect(left, boxTop, width, boxBottom - boxTop, 8).lineWidth(1).stroke(PDF_LINE);
      doc.y = boxBottom + 8;

      if (seg.layover_after) {
        doc.font("Helvetica-Oblique").fontSize(8.5).fillColor(PDF_MUTED)
          .text(`Layover: ${seg.layover_after.label} in ${seg.layover_after.airport}`, left, doc.y, { width });
        doc.moveDown(0.5);
      }
    });
    doc.moveDown(0.3);
  });

  if (!itinerary.length) {
    doc.font("Helvetica").fontSize(10).fillColor(PDF_MUTED)
      .text(order.route_summary ? order.route_summary.replace("→", "-") : "Route details unavailable.", left, doc.y, {
        width,
      });
    doc.moveDown(1);
  }

  // ---- Passenger ----
  doc.moveDown(0.6);
  const names = order.passenger_names && order.passenger_names.length
    ? order.passenger_names
    : (order.passenger_name ? [order.passenger_name] : []);
  doc.font("Helvetica-Bold").fontSize(10).fillColor(brand.accent)
    .text(names.length > 1 ? "PASSENGERS" : "PASSENGER", left, doc.y, { characterSpacing: 0.8 });
  doc.moveDown(0.4);
  (names.length ? names : ["—"]).forEach((n) => {
    doc.font("Helvetica-Bold").fontSize(11).fillColor(PDF_INK).text(n, left, doc.y);
  });
  if (order.payment_required_by) {
    doc.font("Helvetica").fontSize(9).fillColor(PDF_MUTED)
      .text(`Hold expires ${new Date(order.payment_required_by).toUTCString()}`, left, doc.y + 2);
  }

  // ---- Footer notices ----
  doc.moveDown(1.6);
  doc.save().lineWidth(1).strokeColor(PDF_LINE).moveTo(left, doc.y).lineTo(right, doc.y).stroke().restore();
  doc.moveDown(0.8);

  const footerFont = () => doc.font("Helvetica").fontSize(8.5).fillColor(PDF_MUTED);

  footerFont().text(
    `Verification: This reservation can be independently verified with ${order.airline || "the operating carrier"} ` +
      "using the booking reference above. It reflects a genuine reservation held in the airline's own system. This " +
      "document does not itself constitute a ticket unless the status above shows Confirmed & ticketed.",
    left,
    doc.y,
    { width }
  );
  doc.moveDown(0.6);
  footerFont().text(
    "Travel requirements: Entry requirements, visas, and health documentation vary by destination and can change " +
      "without notice. Please confirm current requirements with the relevant embassy, consulate, or airline before travelling.",
    left,
    doc.y,
    { width }
  );
  doc.moveDown(0.6);
  footerFont().text(
    "All times shown are local to the relevant airport. This itinerary has been prepared to support a visa or " +
      "immigration application and reflects the traveller's intended itinerary at the time of issue.",
    left,
    doc.y,
    { width }
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Peregrin demo running on http://localhost:${PORT}`));
