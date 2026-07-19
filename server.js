import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const DUFFEL_API_KEY = process.env.DUFFEL_API_KEY;
const DUFFEL_BASE = "https://api.duffel.com";

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

// Search flights: creates an offer request and returns the offers
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

// Create a hold order (Duffel's "Hold Order & Pay Later" feature)
app.post("/api/hold", async (req, res) => {
  try {
    const { offer_id, passenger } = req.body;

    // Refetch the offer to get live passenger requirements
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

    res.json({
      order_id: result.data.id,
      booking_reference: result.data.booking_reference,
      payment_status: result.data.payment_status,
      total_amount: result.data.total_amount,
      total_currency: result.data.total_currency,
      slices: result.data.slices,
    });
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

// Fetch order details (for the confirmation / countdown screen)
app.get("/api/order/:id", async (req, res) => {
  try {
    const result = await duffel(`/air/orders/${req.params.id}`);
    res.json({
      order_id: result.data.id,
      booking_reference: result.data.booking_reference,
      payment_status: result.data.payment_status,
      total_amount: result.data.total_amount,
      total_currency: result.data.total_currency,
      slices: result.data.slices,
    });
  } catch (err) {
    console.error(err.body || err);
    res.status(err.status || 500).json({ error: err.body || err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Peregrin demo running on http://localhost:${PORT}`));
