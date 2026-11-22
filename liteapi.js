// LiteAPI (Nuitee Connect) client + response normalisers for on-site hotel
// booking. Real hotel bookings: the guest pays through LiteAPI's payment SDK,
// so card details never touch Peregrin's servers.
//
// SANDBOX ONLY until Liam approves go-live. The key decides the mode: sandbox
// keys start "sand_". isSandbox() is the single switch the browser is told
// about (it picks the payment SDK's publicKey), never the key itself.
//
// Pure functions (normalise*, cancelDeadline, signing) are exported for tests.

import crypto from "crypto";

const DATA_BASE = "https://api.liteapi.travel/v3.0";
const BOOK_BASE = "https://book.liteapi.travel/v3.0";

export function liteKey() { return process.env.LITEAPI_KEY || ""; }
export function liteConfigured() { return !!liteKey(); }
export function isSandbox() { return liteKey().startsWith("sand_"); }

// Peregrin's margin, in percent, passed to LiteAPI on every rates search
// (LiteAPI adds it to the net rate and returns it as commission). One value.
export const HOTEL_MARGIN_PCT = Number(process.env.HOTEL_MARGIN_PCT || 8);

async function call(base, path, { method = "GET", body, timeoutMs = 25000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, {
      method,
      headers: { "X-API-Key": liteKey(), accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 300) }; }
    if (!res.ok || json.error) {
      const msg = (json.error && (json.error.message || json.error.description || json.error)) || json.message || `LiteAPI ${res.status}`;
      throw Object.assign(new Error(typeof msg === "string" ? msg : JSON.stringify(msg)), { status: res.status || 502, body: json });
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

export const lite = {
  places: (q, lang = "en") =>
    call(DATA_BASE, `/data/places?textQuery=${encodeURIComponent(q)}&language=${encodeURIComponent(lang)}`),
  rates: (body) => call(DATA_BASE, "/hotels/rates", { method: "POST", body, timeoutMs: 30000 }),
  prebook: (offerId) => call(BOOK_BASE, "/rates/prebook", { method: "POST", body: { offerId, usePaymentSdk: true } }),
  book: (body) => call(BOOK_BASE, "/rates/book", { method: "POST", body, timeoutMs: 60000 }),
  booking: (id) => call(BOOK_BASE, `/bookings/${encodeURIComponent(id)}`),
  cancel: (id) => call(BOOK_BASE, `/bookings/${encodeURIComponent(id)}`, { method: "PUT" }),
  hotel: (id) => call(DATA_BASE, `/data/hotel?hotelId=${encodeURIComponent(id)}&timeout=4`),
};

// ---- normalisers ---------------------------------------------------------

const amt = (arr) => (Array.isArray(arr) && arr[0] ? { amount: Number(arr[0].amount), currency: arr[0].currency } : null);

// LiteAPI gives "2026-12-11 10:00:00" plus a timezone ("GMT" in every sandbox
// response seen). The deadline is the moment the first penalty starts, so free
// cancellation runs UNTIL that instant. Returned as an ISO UTC string; the
// browser formats it in the visitor's own timezone.
export function cancelDeadline(cp) {
  if (!cp || cp.refundableTag !== "RFN") return null;
  const infos = (cp.cancelPolicyInfos || []).filter((i) => i && i.cancelTime);
  if (!infos.length) return null;
  const times = infos.map((i) => {
    const tz = String(i.timezone || "GMT").toUpperCase();
    const iso = String(i.cancelTime).trim().replace(" ", "T");
    // Only GMT/UTC is documented in responses; anything else is treated as UTC
    // too and flagged, rather than silently shifted.
    return { ms: Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z"), tz };
  }).filter((x) => !Number.isNaN(x.ms));
  if (!times.length) return null;
  const first = Math.min(...times.map((x) => x.ms));
  return new Date(first).toISOString();
}

export function normaliseRate(rate, offer) {
  const rr = rate.retailRate || {};
  const total = amt(rr.total) || (offer && offer.offerRetailRate ? { amount: Number(offer.offerRetailRate.amount), currency: offer.offerRetailRate.currency } : null);
  const ssp = amt(rr.suggestedSellingPrice);
  const fees = (rr.taxesAndFees || []).filter(Boolean);
  const cp = rate.cancellationPolicies || {};
  return {
    offerId: offer ? offer.offerId : rate.offerId,
    name: rate.name || "",
    board: rate.boardName || "",
    total,
    ssp,
    refundable: cp.refundableTag === "RFN",
    cancelDeadline: cancelDeadline(cp),
    // "included: false" means not in the total: paid at the property.
    payAtProperty: fees.filter((f) => f.included === false).map((f) => ({ description: f.description || "Taxes and fees", amount: Number(f.amount), currency: f.currency })),
  };
}

// One card per hotel; each hotel keeps its cheapest refundable and cheapest
// non-refundable offer so the browser can toggle "Free cancellation only"
// without another API call. Hotel details come from includeHotelData.
export function normaliseRates(resp) {
  const info = new Map((resp.hotels || []).map((h) => [h.id, h]));
  const out = [];
  for (const h of resp.data || []) {
    const offers = [];
    for (const rt of h.roomTypes || []) {
      const r0 = (rt.rates || [])[0];
      if (!r0) continue;
      // An offer can bundle several rooms; its price is the offer total.
      const n = normaliseRate(r0, rt);
      if (rt.offerRetailRate) n.total = { amount: Number(rt.offerRetailRate.amount), currency: rt.offerRetailRate.currency };
      if (rt.suggestedSellingPrice) n.ssp = { amount: Number(rt.suggestedSellingPrice.amount), currency: rt.suggestedSellingPrice.currency };
      // Never sell below LiteAPI's suggested selling price publicly: an offer
      // whose price (net + our margin) is under SSP is left out.
      if (n.total && !(n.ssp && n.total.amount + 0.005 < n.ssp.amount)) offers.push(n);
    }
    const cheapest = (list) => list.sort((a, b) => a.total.amount - b.total.amount)[0] || null;
    const rfn = cheapest(offers.filter((o) => o.refundable));
    const nrfn = cheapest(offers.filter((o) => !o.refundable));
    if (!rfn && !nrfn) continue;
    const meta = info.get(h.hotelId) || {};
    out.push({
      id: h.hotelId,
      name: meta.name || "Hotel",
      photo: meta.thumbnail || meta.main_photo || "",
      stars: Number(meta.stars) || 0,
      rating: Number(meta.rating) || null,
      address: meta.address || "",
      city: meta.city_name || "",
      refundable: rfn,
      nonRefundable: nrfn,
    });
  }
  return out;
}

export function normalisePrebook(p) {
  const d = p.data || p;
  const rate = d.roomTypes && d.roomTypes[0] && d.roomTypes[0].rates && d.roomTypes[0].rates[0];
  const cp = (rate && rate.cancellationPolicies) || {};
  const fees = ((rate && rate.retailRate && rate.retailRate.taxesAndFees) || []).filter((f) => f && f.included === false);
  return {
    prebookId: d.prebookId,
    transactionId: d.transactionId,
    secretKey: d.secretKey,
    hotelId: d.hotelId,
    price: Number(d.price),
    currency: d.currency,
    priceChanged: Number(d.priceDifferencePercent || 0) !== 0,
    cancellationChanged: !!d.cancellationChanged,
    refundable: cp.refundableTag === "RFN",
    cancelDeadline: cancelDeadline(cp),
    roomName: (rate && rate.name) || "",
    board: (rate && rate.boardName) || "",
    checkin: d.checkin,
    checkout: d.checkout,
    payAtProperty: fees.map((f) => ({ description: f.description || "Taxes and fees", amount: Number(f.amount), currency: f.currency })),
  };
}

// Cancel (PUT /bookings/{id}) returns snake_case fields.
export function normaliseCancel(r) {
  const d = r.data || r;
  const num = (v) => (v == null || v === "" ? null : Number(v));
  return {
    status: d.status || "",
    refundAmount: num(d.refund_amount != null ? d.refund_amount : d.refundAmount),
    cancellationFee: num(d.cancellation_fee != null ? d.cancellation_fee : d.cancellationFee),
    currency: d.currency || "",
  };
}

export function normaliseBooking(b) {
  const d = b.data || b;
  const cp = d.cancellationPolicies || (d.rooms && d.rooms[0] && d.rooms[0].cancellationPolicies) || {};
  const room = (d.bookedRooms && d.bookedRooms[0]) || (d.rooms && d.rooms[0]) || {};
  const hotel = d.hotel || {};
  const holder = d.holder || {};
  return {
    bookingId: d.bookingId,
    status: d.status || "",
    hotelConfirmationCode: d.hotelConfirmationCode || "",
    supplierBookingId: d.supplierBookingId || "",
    hotelName: hotel.name || d.hotelName || "",
    hotelAddress: [hotel.address, hotel.city, hotel.country].filter(Boolean).join(", ") || d.hotelAddress || "",
    hotelId: hotel.hotelId || d.hotelId || "",
    checkin: d.checkin,
    checkout: d.checkout,
    guestName: [holder.firstName, holder.lastName].filter(Boolean).join(" "),
    email: holder.email || "",
    roomName: (room.roomType && room.roomType.name) || room.name || "",
    board: room.boardName || "",
    adults: room.adults || null,
    price: Number(d.price != null ? d.price : d.sellingPrice || 0),
    currency: d.currency || "",
    refundable: cp.refundableTag === "RFN",
    cancelDeadline: cancelDeadline(cp) || (cp.refundableTag === "RFN" && d.lastFreeCancellationDate ? cancelDeadline({ refundableTag: "RFN", cancelPolicyInfos: [{ cancelTime: d.lastFreeCancellationDate, timezone: "GMT" }] }) : null),
    lastFreeCancellationDate: d.lastFreeCancellationDate || "",
    amountRefunded: d.amountRefunded != null ? Number(d.amountRefunded) : null,
    cancelledAt: d.cancelledAt || "",
    createdAt: d.createdAt || d.creationDate || "",
  };
}

// ---- signed links (confirmation, PDF, cancel) -----------------------------
// No database: a booking page is reachable only with an HMAC of its id. The
// secret is HOTEL_LINK_SECRET when set, else derived from the LiteAPI key.

function linkSecret() {
  return process.env.HOTEL_LINK_SECRET || crypto.createHash("sha256").update("peregrin-hotel-links:" + liteKey()).digest("hex");
}
export function signBooking(id) {
  return crypto.createHmac("sha256", linkSecret()).update(String(id)).digest("base64url").slice(0, 32);
}
export function verifyBooking(id, sig) {
  const want = Buffer.from(signBooking(id));
  const got = Buffer.from(String(sig || ""));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
