// Launch waitlist: flight reservations are paused (Duffel live holds are not
// enabled yet), so buyers who hit that wall can leave an email for 20% off
// when reservations return.
//
// Storage: Resend (the provider that already sends from send.peregrin.travel)
// as a contact in the "Peregrin launch waitlist" audience. The audience id is
// RESEND_WAITLIST_AUDIENCE_ID when set; otherwise it is found or created by
// name on first use. Route and travel date are not Resend contact fields, so
// they ride along in a server-side PostHog event as a second record.
// Nothing is stored in the browser.
//
// The launch email itself is NOT sent from here; Liam sends it when holds
// return. This file only confirms the signup.

import crypto from "crypto";

export const WAITLIST_AUDIENCE_NAME = "Peregrin launch waitlist";
const LANGS = ["en", "es", "ru", "hi"];

export const WAITLIST_EMAIL = {
  en: { subject: "You're on the Peregrin launch list",
    p1: "Thanks for leaving your email. New flight reservations are paused while we add a new airline partner.",
    p2: "When reservations are back we'll email you once, with 20% off your first reservation.",
    p3: "That is the only thing we'll email you about.", unsub: "Unsubscribe", route: "Route", date: "Travel date" },
  es: { subject: "Ya estás en la lista de lanzamiento de Peregrin",
    p1: "Gracias por dejarnos tu correo. Las nuevas reservas de vuelo están en pausa mientras añadimos un nuevo socio aéreo.",
    p2: "Cuando vuelvan las reservas te escribiremos una vez, con un 20% de descuento en tu primera reserva.",
    p3: "Es lo único sobre lo que te escribiremos.", unsub: "Darse de baja", route: "Ruta", date: "Fecha de viaje" },
  ru: { subject: "Вы в списке запуска Peregrin",
    p1: "Спасибо, что оставили email. Новые бронирования рейсов приостановлены, пока мы подключаем нового авиапартнёра.",
    p2: "Когда бронирование возобновится, мы напишем вам один раз и пришлём скидку 20% на первое бронирование.",
    p3: "Других писем по этому поводу не будет.", unsub: "Отписаться", route: "Маршрут", date: "Дата поездки" },
  hi: { subject: "आप Peregrin लॉन्च सूची में हैं",
    p1: "ईमेल देने के लिए धन्यवाद। नए एयरलाइन पार्टनर को जोड़ने तक नए फ्लाइट आरक्षण रुके हुए हैं।",
    p2: "आरक्षण वापस आने पर हम आपको एक बार ईमेल करेंगे, आपके पहले आरक्षण पर 20% की छूट के साथ।",
    p3: "हम आपको केवल इसी बारे में ईमेल करेंगे।", unsub: "अनसब्सक्राइब करें", route: "रूट", date: "यात्रा की तारीख" },
};

const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function secret(RESEND_API_KEY) {
  return process.env.WAITLIST_LINK_SECRET || crypto.createHash("sha256").update("peregrin-waitlist:" + (RESEND_API_KEY || "")).digest("hex");
}
export function unsubToken(email, key) {
  return crypto.createHmac("sha256", secret(key)).update(String(email).toLowerCase()).digest("base64url").slice(0, 32);
}
export function cleanSignup(body) {
  const b = body || {};
  const email = String(b.email || "").trim().slice(0, 200);
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
  const travel_date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.travel_date || "")) ? b.travel_date : "";
  const route = String(b.route || "").replace(/[^A-Za-z0-9 →>-]/g, "").slice(0, 40);
  const source = String(b.source || "").replace(/[^a-z0-9/_-]/gi, "").slice(0, 60) || "unknown";
  const lang = LANGS.includes(b.lang) ? b.lang : "en";
  return { ok, email, travel_date, route, source, lang, bot: !!String(b.website || "").trim() };
}

export function registerLaunchWaitlist(app, { RESEND_API_KEY, EMAIL_FROM, SITE_ORIGIN, POSTHOG_KEY, POSTHOG_HOST }) {
  let audienceId = process.env.RESEND_WAITLIST_AUDIENCE_ID || "";
  const resend = (path, opts = {}) => fetch("https://api.resend.com" + path, {
    ...opts, headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
  }).then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) }));

  async function getAudience() {
    if (audienceId) return audienceId;
    const list = await resend("/audiences");
    const found = (list.json.data || []).find((a) => a.name === WAITLIST_AUDIENCE_NAME);
    if (found) return (audienceId = found.id);
    const made = await resend("/audiences", { method: "POST", body: JSON.stringify({ name: WAITLIST_AUDIENCE_NAME }) });
    if (!made.ok || !made.json.id) throw new Error(`audience create failed (${made.status})`);
    return (audienceId = made.json.id);
  }

  const hitsByIp = new Map();
  app.post("/api/launch-waitlist", async (req, res) => {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
    const now = Date.now();
    const hits = (hitsByIp.get(ip) || []).filter((t) => now - t < 3600e3);
    if (hits.length >= 6) return res.status(429).json({ error: "Too many signups from this connection. Please try again later." });
    hits.push(now); hitsByIp.set(ip, hits);

    const s = cleanSignup(req.body);
    if (!s.ok) return res.status(400).json({ error: "Please enter a valid email address." });
    if (s.bot) return res.json({ ok: true }); // honeypot: pretend success, store nothing
    if (!RESEND_API_KEY) return res.status(503).json({ error: "Signups aren't available right now." });

    // 1. Store with the email provider.
    let stored = false;
    try {
      const id = await getAudience();
      const c = await resend(`/audiences/${id}/contacts`, { method: "POST", body: JSON.stringify({ email: s.email, unsubscribed: false }) });
      stored = c.ok || /already exists/i.test(JSON.stringify(c.json));
      if (!stored) console.error("waitlist contact store failed", c.status, c.json);
    } catch (err) {
      console.error("waitlist audience error:", err.message);
    }
    // 2. Second record with the details Resend contacts can't hold.
    let tracked = false;
    if (POSTHOG_KEY) {
      try {
        const r = await fetch(`${POSTHOG_HOST}/capture/`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: POSTHOG_KEY, event: "waitlist_signup_stored", distinct_id: s.email,
            properties: { source: s.source, route: s.route, language: s.lang, travel_date: s.travel_date, resend_stored: stored } }) });
        tracked = r.ok;
      } catch { /* best effort */ }
    }
    if (!stored && !tracked) return res.status(502).json({ error: "We couldn't save that just now. Please try again." });

    // 3. Confirmation from peregrin.travel's sending domain.
    const t = WAITLIST_EMAIL[s.lang];
    const unsub = `${SITE_ORIGIN}/waitlist/unsubscribe?e=${encodeURIComponent(s.email)}&t=${unsubToken(s.email, RESEND_API_KEY)}`;
    const details = [s.route ? `${esc(t.route)}: ${esc(s.route)}` : "", s.travel_date ? `${esc(t.date)}: ${esc(s.travel_date)}` : ""].filter(Boolean).join("<br/>");
    const sent = await resend("/emails", { method: "POST", body: JSON.stringify({
      from: EMAIL_FROM, to: s.email, subject: t.subject,
      headers: { "List-Unsubscribe": `<${unsub}>` },
      html: `<p>${esc(t.p1)}</p><p>${esc(t.p2)}</p>${details ? `<p>${details}</p>` : ""}<p>${esc(t.p3)}</p><p>Peregrin</p><p style="font-size:12px;color:#5c6b7c"><a href="${unsub}">${esc(t.unsub)}</a></p>`,
    }) }).catch(() => ({ ok: false }));
    res.json({ ok: true, stored, emailed: !!sent.ok, email_id: sent.json && sent.json.id ? sent.json.id : null });
  });

  app.get("/waitlist/unsubscribe", async (req, res) => {
    const email = String(req.query.e || "").trim();
    const page = (msg) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Peregrin</title></head><body style="font-family:system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;color:#16283a"><p><strong>Peregrin</strong></p><p>${msg}</p><p><a href="/">peregrin.travel</a></p></body></html>`;
    const want = Buffer.from(unsubToken(email, RESEND_API_KEY)), got = Buffer.from(String(req.query.t || ""));
    if (!email || !RESEND_API_KEY || want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
      return res.status(400).type("html").send(page("This unsubscribe link isn't valid. Email hello@peregrin.travel and we'll remove you."));
    }
    try {
      const id = await getAudience();
      await resend(`/audiences/${id}/contacts/${encodeURIComponent(email)}`, { method: "PATCH", body: JSON.stringify({ unsubscribed: true }) });
    } catch (err) { console.error("waitlist unsubscribe failed:", err.message); }
    res.type("html").send(page("You're unsubscribed. We won't email you about the launch."));
  });
}
