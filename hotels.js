// /hotels: on-site hotel booking via LiteAPI (Nuitee Connect). Real hotel
// bookings; the guest pays through LiteAPI's payment SDK, so Peregrin never
// sees card details. Copy lives in hotels-copy.js; the JSON API and booking
// routes live in hotel-booking.js.
//
// Pages rendered here:
//   /hotels (+ /es /ru /hi)       search, results, guest details, payment
//   /hotels/complete              payment return: books, then redirects
//   /hotels/booking/:id           signed confirmation page
//   /hotels/booking/:id/cancel    signed self-serve cancellation
//
// Deadlines are sent as ISO UTC and formatted in the browser, in the visitor's
// own timezone ("Free cancellation until 14 Dec 2026, 23:59").

import { HOTELS_COPY } from "./hotels-copy.js";
export { HOTELS_COPY };

export const HOTELS_PATHS = { en: "/hotels", es: "/es/hotels", ru: "/ru/hotels", hi: "/hi/hotels" };
const HOME = { en: "/", es: "/es", ru: "/ru", hi: "/hi" };
const LOCALE = { en: "en-GB", es: "es-ES", ru: "ru-RU", hi: "hi-IN" };
const LANG_LABEL = { en: "EN", es: "ES", ru: "RU", hi: "HI" };
export const PAYMENT_SDK_URL = "https://payment-wrapper.liteapi.travel/dist/liteAPIPayment.js?v=a1";

function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// JSON safe to drop inside a <script> block.
const js = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

const CSS = `
  @font-face { font-family:'Public Sans'; font-weight:400; font-display:swap; src:url('/fonts/publicsans-400-latin.woff2') format('woff2'); }
  @font-face { font-family:'Public Sans'; font-weight:700; font-display:swap; src:url('/fonts/publicsans-700-latin.woff2') format('woff2'); }
  :root { --ink:#16283a; --muted:#5c6b7c; --line:#e2e7ec; --bg:#f8f9fb; --accent:#1c6f8c;
    --accent-bg:#e8f2f5; --accent-dark:#124a5e; --gold:#c9922e; --gold-bg:#faf1e0; --ok:#1f7a5c; --ok-bg:#e7f4ee; --bad:#8a3a2c; --bad-bg:#fbeeee; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:"Public Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
    color:var(--ink); background: radial-gradient(1100px 420px at 50% -140px, var(--accent-bg), transparent 70%), var(--bg); }
  .wrap { max-width:760px; margin:0 auto; padding:0 20px 80px; }
  header.site { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:22px 0 30px; flex-wrap:wrap; }
  .brand { display:flex; align-items:center; gap:9px; text-decoration:none; color:var(--ink); }
  .brand .mark { font-weight:800; letter-spacing:.04em; font-size:15px; text-transform:uppercase; }
  .nav { display:flex; gap:14px; align-items:center; font-size:13px; }
  .nav a { color:var(--accent); text-decoration:none; }
  .langs { color:var(--muted); font-size:12.5px; letter-spacing:.03em; }
  .langs span[aria-current] { color:var(--ink); font-weight:700; }
  .eyebrow { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; color:var(--accent); margin:0; }
  h1 { font-family:"Source Serif 4",Georgia,serif; font-size:34px; line-height:1.15; letter-spacing:-.02em; margin:8px 0 12px; }
  .lede { font-size:16px; color:var(--muted); line-height:1.65; margin:0 0 10px; }
  .real { font-size:14px; font-weight:700; color:var(--ok); margin:0 0 22px; }
  h2 { font-family:"Source Serif 4",Georgia,serif; font-size:21px; margin:30px 0 12px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:14px; padding:20px; }
  form.hs { display:grid; grid-template-columns:1fr 1fr 1fr; gap:14px; }
  form.hs .full { grid-column:1 / -1; }
  label.f { display:block; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin-bottom:6px; }
  input, select { width:100%; font:inherit; font-size:15px; padding:11px 12px; border:1px solid var(--line); border-radius:9px; color:var(--ink); background:#fff; }
  input:focus, select:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-bg); }
  .dest { position:relative; }
  .sugg { position:absolute; z-index:5; left:0; right:0; top:100%; margin:4px 0 0; padding:4px; list-style:none; background:#fff; border:1px solid var(--line); border-radius:10px; box-shadow:0 10px 30px rgba(22,40,58,.12); }
  .sugg li { padding:9px 10px; border-radius:7px; cursor:pointer; font-size:14.5px; }
  .sugg li small { color:var(--muted); display:block; font-size:12.5px; }
  .sugg li[aria-selected="true"], .sugg li:hover { background:var(--accent-bg); }
  .btn { display:block; width:100%; text-align:center; text-decoration:none; font:inherit; font-weight:700; font-size:15.5px; background:var(--ink); color:#fff; border:none; border-radius:9px; padding:14px 18px; cursor:pointer; }
  .btn:hover { background:#0e1c2b; } .btn:disabled { opacity:.6; cursor:default; }
  .btn.ghost { background:none; color:var(--accent); border:1px solid var(--line); }
  .toggle { display:flex; align-items:center; gap:10px; font-weight:700; font-size:14.5px; cursor:pointer; }
  .toggle input { width:auto; accent-color:var(--accent); transform:scale(1.25); }
  .visa { font-size:13.5px; color:var(--accent-dark); background:var(--accent-bg); border-radius:9px; padding:9px 12px; margin:0; }
  .msg { font-size:14px; margin:14px 0 0; } .msg.err { color:var(--bad); font-weight:600; }
  .sandbox { font-size:13px; background:var(--gold-bg); border:1px solid #ecd9ad; border-radius:9px; padding:9px 12px; margin:0 0 16px; }
  .count { font-size:13px; color:var(--muted); margin:22px 0 10px; }
  .hotel { display:grid; grid-template-columns:150px 1fr; gap:16px; background:#fff; border:1px solid var(--line); border-radius:14px; padding:14px; margin-bottom:12px; }
  .hotel img { width:150px; height:118px; object-fit:cover; border-radius:9px; background:var(--accent-bg); }
  .hotel h3 { margin:0 0 3px; font-size:16.5px; }
  .meta { font-size:13px; color:var(--muted); margin:0 0 8px; }
  .stars { color:var(--gold); letter-spacing:1px; }
  .rate { border-top:1px solid var(--line); padding-top:10px; margin-top:10px; display:flex; justify-content:space-between; gap:12px; align-items:flex-end; flex-wrap:wrap; }
  .rate:first-of-type { border-top:none; padding-top:0; margin-top:0; }
  .tag { display:inline-block; font-size:12px; font-weight:700; border-radius:100px; padding:3px 9px; margin-bottom:5px; }
  .tag.rf { background:var(--ok-bg); color:var(--ok); } .tag.nr { background:var(--bad-bg); color:var(--bad); }
  .small { font-size:13px; color:var(--muted); margin:2px 0; line-height:1.45; }
  .price { font-weight:800; font-size:17px; }
  .rate > div:first-child { flex:1 1 220px; } .rate > div:last-child { flex:0 0 auto; text-align:right; }
  .rate .btn { width:auto; padding:10px 14px; font-size:14px; margin-top:6px; }
  /* LiteAPI payment SDK's Pay button */
  #targetElement .lp-submit-button, #targetElement button[type="submit"] { display:block; width:100%; margin-top:14px; font:inherit; font-weight:700; font-size:15.5px; background:var(--ink); color:#fff; border:none; border-radius:9px; padding:14px 18px; cursor:pointer; }
  .warn { background:var(--bad-bg); color:var(--bad); font-weight:700; border-radius:9px; padding:10px 12px; margin:12px 0; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  dl.kv { display:grid; grid-template-columns:max-content 1fr; gap:8px 16px; margin:0; font-size:14.5px; }
  dl.kv dt { color:var(--muted); } dl.kv dd { margin:0; font-weight:600; }
  .status { display:inline-block; font-weight:800; border-radius:100px; padding:4px 12px; font-size:13px; }
  .status.ok { background:var(--ok-bg); color:var(--ok); } .status.bad { background:var(--bad-bg); color:var(--bad); }
  .actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:18px; } .actions .btn { width:auto; }
  #targetElement { margin-top:14px; min-height:60px; }
  ul.tips { margin:0; padding-left:20px; font-size:14.5px; line-height:1.75; }
  .flight { margin-top:34px; background:var(--gold-bg); border:1px solid #ecd9ad; border-radius:12px; padding:16px 18px; }
  .flight h2 { margin:0 0 6px; font-size:18px; } .flight p { margin:0 0 10px; font-size:14.5px; line-height:1.6; }
  .flight a { color:var(--accent-dark); font-weight:700; text-decoration:none; }
  footer.site { border-top:1px solid var(--line); margin-top:44px; padding:20px 0; font-size:12.5px; color:var(--muted); }
  footer.site a { color:var(--accent); text-decoration:none; }
  [hidden] { display:none !important; }
  @media (max-width:600px) { form.hs, .grid2 { grid-template-columns:1fr; } h1 { font-size:28px; }
    .hotel { grid-template-columns:1fr; } .hotel img { width:100%; height:160px; } }
`;

function shell({ lang, title, meta, canonical, alternates = "", noindex = false, headExtra = "", body, langNav = "" }) {
  const t = HOTELS_COPY[lang] || HOTELS_COPY.en;
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
${meta ? `<meta name="description" content="${esc(meta)}">` : ""}
${noindex ? `<meta name="robots" content="noindex, nofollow">` : ""}
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ""}
${alternates}
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#16283a">
${canonical ? `<meta property="og:type" content="website"><meta property="og:site_name" content="Peregrin"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(meta)}"><meta property="og:url" content="${esc(canonical)}">` : ""}
${headExtra}
<style>${CSS}</style>
</head>
<body>
  <div class="wrap">
    <header class="site">
      <a class="brand" href="${HOME[lang]}">
        <svg width="26" height="26" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <path d="M5 28C11 26 16 20 19 8" stroke="var(--accent)" stroke-width="4" stroke-linecap="round"/>
          <path d="M12 31C18 28 23 22 26 11" stroke="var(--accent)" stroke-width="4" stroke-linecap="round" opacity="0.55"/>
          <path d="M19 34C25 31 29 25 32 15" stroke="var(--gold)" stroke-width="4" stroke-linecap="round"/>
        </svg>
        <span class="mark">Peregrin</span>
      </a>
      <nav class="nav">${langNav ? `<span class="langs">${langNav}</span>` : ""}<a href="/faq">${esc(t.help)}</a></nav>
    </header>
${body}
    <footer class="site">
      <a href="${HOME[lang]}">Peregrin</a> &middot; <a href="/blog">${esc(t.guides)}</a> &middot; <a href="/faq">${esc(t.help)}</a> &middot; <a href="mailto:hello@peregrin.travel">hello@peregrin.travel</a>
    </footer>
  </div>
</body>
</html>`;
}

// Shared browser helpers: copy lookup with {placeholders}, money and deadline
// formatting in the visitor's locale and timezone, and the analytics shim.
function clientHelpers(lang) {
  const t = HOTELS_COPY[lang] || HOTELS_COPY.en;
  return `
  var LANG = ${js(lang)}, LOCALE = ${js(LOCALE[lang])}, T = ${js({ ...t, email: undefined, title: undefined, meta: undefined })};
  function tr(k, v) { var s = T[k] || ""; if (v) Object.keys(v).forEach(function (x) { s = s.split("{" + x + "}").join(v[x]); }); return s; }
  function money(a, c) { try { return new Intl.NumberFormat(LOCALE, { style: "currency", currency: c || "USD" }).format(a); } catch (e) { return (c || "") + " " + Number(a).toFixed(2); } }
  function deadline(iso) {
    var d = new Date(iso); if (isNaN(d)) return "";
    try { return new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d); }
    catch (e) { return d.toLocaleString(); }
  }
  function track(n, p) { try { if (window.peregrinTrack) window.peregrinTrack(n, p || {}); } catch (e) {} }
  function escH(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  // Server-rendered deadlines arrive as <time data-utc>; localise them here.
  Array.prototype.forEach.call(document.querySelectorAll("time[data-utc]"), function (el) {
    var s = deadline(el.getAttribute("data-utc")); if (!s) return;
    var tpl = el.getAttribute("data-tpl"); el.textContent = tpl ? tr(tpl, { d: s }) : s;
  });`;
}

// ---------------------------------------------------------------- /hotels
export function renderHotelsPage({ lang = "en", origin, headExtra = "", sandbox = false }) {
  const t = HOTELS_COPY[lang] || HOTELS_COPY.en;
  const self = origin + HOTELS_PATHS[lang];
  const alternates = Object.entries(HOTELS_PATHS)
    .map(([l, p]) => `<link rel="alternate" hreflang="${l}" href="${esc(origin + p)}">`)
    .concat(`<link rel="alternate" hreflang="x-default" href="${esc(origin + HOTELS_PATHS.en)}">`)
    .join("\n");
  const langNav = Object.entries(HOTELS_PATHS)
    .map(([l, p]) => l === lang ? `<span aria-current="page">${LANG_LABEL[l]}</span>` : `<a href="${p}" hreflang="${l}" lang="${l}">${LANG_LABEL[l]}</a>`)
    .join(" ");
  const guestOptions = [1, 2, 3, 4].map((n) => `<option value="${n}"${n === 2 ? " selected" : ""}>${n}</option>`).join("");

  const body = `
    <p class="eyebrow">${esc(t.eyebrow)}</p>
    <h1>${esc(t.h1)}</h1>
    <p class="lede">${esc(t.intro)}</p>
    <p class="real">${esc(t.real)}</p>
    ${sandbox ? `<p class="sandbox" id="sandbox-note">${esc(t.sandbox)}</p>` : ""}

    <section id="search-view">
      <form class="hs card" id="hotel-form" novalidate autocomplete="off">
        <div class="full dest">
          <label class="f" for="hs-dest">${esc(t.destination)}</label>
          <input id="hs-dest" type="text" placeholder="${esc(t.dest_ph)}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="hs-sugg">
          <ul class="sugg" id="hs-sugg" role="listbox" hidden></ul>
        </div>
        <div><label class="f" for="hs-in">${esc(t.checkin)}</label><input id="hs-in" type="date" required></div>
        <div><label class="f" for="hs-out">${esc(t.checkout)}</label><input id="hs-out" type="date" required></div>
        <div><label class="f" for="hs-guests">${esc(t.guests)}</label><select id="hs-guests">${guestOptions}</select></div>
        <label class="toggle full"><input type="checkbox" id="hs-free" checked> ${esc(t.free_only)}</label>
        <p class="visa full">${esc(t.visa_line)}</p>
        <button class="btn full" id="hs-go" type="submit">${esc(t.search)}</button>
      </form>
      <p class="msg" id="hs-msg" role="status" hidden></p>
      <p class="count" id="hs-count" hidden></p>
      <div id="hs-results"></div>

      <h2>${esc(t.tips_h)}</h2>
      <ul class="tips">${t.tips.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      <div class="flight">
        <h2>${esc(t.flight_h)}</h2>
        <p>${esc(t.flight_p)}</p>
        <a href="${HOME[lang]}">${esc(t.flight_cta)} &rarr;</a>
      </div>
    </section>

    <section id="checkout-view" hidden>
      <button class="btn ghost" id="co-back" type="button" style="width:auto;margin-bottom:16px">&larr; ${esc(t.back)}</button>
      <div class="card">
        <h2 style="margin-top:0">${esc(t.checkout_h)}</h2>
        <div id="co-summary"></div>
        <p class="warn" id="co-nonref" hidden>${esc(t.nonref_warn)}</p>
        <form id="co-form" novalidate>
          <h2 style="font-size:17px">${esc(t.guest_h)}</h2>
          <div class="grid2">
            <div><label class="f" for="g-first">${esc(t.first)}</label><input id="g-first" autocomplete="given-name" required></div>
            <div><label class="f" for="g-last">${esc(t.last)}</label><input id="g-last" autocomplete="family-name" required></div>
            <div><label class="f" for="g-email">${esc(t.email)}</label><input id="g-email" type="email" autocomplete="email" required></div>
            <div><label class="f" for="g-phone">${esc(t.phone)}</label><input id="g-phone" type="tel" autocomplete="tel" required></div>
          </div>
          <p class="msg err" id="co-err" role="alert" hidden></p>
          <button class="btn" id="co-go" type="submit" style="margin-top:16px">${esc(t.continue)}</button>
        </form>
        <div id="pay-view" hidden>
          <h2 style="font-size:17px">${esc(t.pay_h)}</h2>
          <p class="msg" id="pay-price" hidden></p>
          <p class="small">${esc(t.pay_note)}</p>
          <div id="targetElement"></div>
        </div>
      </div>
    </section>
<script>
(function () {
  ${clientHelpers(lang)}
  var SDK = ${js(PAYMENT_SDK_URL)}, SANDBOX = ${js(!!sandbox)};
  var $ = function (id) { return document.getElementById(id); };
  var dest = $("hs-dest"), sugg = $("hs-sugg"), inp = $("hs-in"), out = $("hs-out"), guests = $("hs-guests"), free = $("hs-free");
  var place = null, results = [], search = null, chosen = null, timer = null, seq = 0;

  function ymd(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function addDays(n) { var d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return d; }
  var today = ymd(addDays(0));
  inp.min = today; out.min = ymd(addDays(1)); inp.value = ymd(addDays(21)); out.value = ymd(addDays(24));
  inp.addEventListener("change", function () { out.min = inp.value; if (out.value <= inp.value) { var d = new Date(inp.value + "T12:00:00"); d.setDate(d.getDate() + 3); out.value = ymd(d); } });
  function nights() { return Math.round((new Date(out.value + "T12:00:00") - new Date(inp.value + "T12:00:00")) / 86400000); }
  function msg(text, err) { var m = $("hs-msg"); m.hidden = !text; m.textContent = text || ""; m.className = "msg" + (err ? " err" : ""); }

  // ---- place autocomplete (LiteAPI places) ----
  function closeSugg() { sugg.hidden = true; dest.setAttribute("aria-expanded", "false"); }
  function choose(p) { place = p; dest.value = p.name + (p.detail ? ", " + p.detail : ""); closeSugg(); }
  dest.addEventListener("input", function () {
    place = null; clearTimeout(timer);
    var q = dest.value.trim(); if (q.length < 2) return closeSugg();
    timer = setTimeout(function () {
      var my = ++seq;
      fetch("/api/hotels/places?lang=" + LANG + "&q=" + encodeURIComponent(q)).then(function (r) { return r.json(); }).then(function (d) {
        if (my !== seq) return;
        var list = (d.places || []);
        sugg.innerHTML = list.map(function (p, i) { return '<li role="option" data-i="' + i + '">' + escH(p.name) + (p.detail ? "<small>" + escH(p.detail) + "</small>" : "") + "</li>"; }).join("");
        sugg.hidden = !list.length; dest.setAttribute("aria-expanded", String(!!list.length));
        Array.prototype.forEach.call(sugg.children, function (li) { li.addEventListener("mousedown", function (e) { e.preventDefault(); choose(list[+li.getAttribute("data-i")]); }); });
        sugg._list = list;
      }).catch(function () {});
    }, 220);
  });
  dest.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !sugg.hidden && sugg._list && sugg._list.length) { e.preventDefault(); choose(sugg._list[0]); }
    if (e.key === "Escape") closeSugg();
  });
  dest.addEventListener("blur", function () { setTimeout(closeSugg, 150); });

  // ---- search ----
  $("hotel-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!place) return msg(tr("err_dest"), true);
    if (!inp.value || !out.value || inp.value < today || nights() < 1) return msg(tr("err_dates"), true);
    var go = $("hs-go"); go.disabled = true; go.textContent = tr("searching"); msg(""); $("hs-results").innerHTML = ""; $("hs-count").hidden = true;
    search = { placeId: place.id, place: place.name, checkin: inp.value, checkout: out.value, adults: +guests.value };
    track("hotel_search_submitted", { city: place.name, place_id: place.id, nights: nights(), guests: +guests.value, language: LANG, free_cancellation_only: free.checked });
    fetch("/api/hotels/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(search) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "search"); return d; }); })
      .then(function (d) { results = d.hotels || []; render(); })
      .catch(function () { msg(tr("err_search"), true); })
      .then(function () { go.disabled = false; go.textContent = tr("search"); });
  });
  free.addEventListener("change", function () { track("hotel_filter_toggled", { free_cancellation_only: free.checked, language: LANG }); if (search) render(); });

  function rateRow(h, r) {
    var n = search ? Math.round((new Date(search.checkout + "T12:00:00") - new Date(search.checkin + "T12:00:00")) / 86400000) : 1;
    var price = money(r.total.amount, r.total.currency);
    var lines = [];
    lines.push(r.refundable ? '<span class="tag rf">' + escH(tr("refundable")) + "</span>" : '<span class="tag nr">' + escH(tr("nonref")) + "</span>");
    if (r.name) lines.push('<p class="small">' + escH(r.name) + (r.board ? " &middot; " + escH(r.board) : "") + "</p>");
    if (r.refundable && r.cancelDeadline) lines.push('<p class="small"><strong>' + escH(tr("free_until", { d: deadline(r.cancelDeadline) })) + "</strong></p>");
    if (r.payAtProperty && r.payAtProperty.length) lines.push('<p class="small">' + escH(tr("pay_at_property", { list: r.payAtProperty.map(function (f) { return f.description + " " + money(f.amount, f.currency); }).join(", ") })) + "</p>");
    var sentence = n === 1 ? tr("total1") : tr("total", { n: n });
    return '<div class="rate"><div>' + lines.join("") + '</div><div><div class="price">' + escH(price) + '</div><p class="small">' +
      escH(sentence) + '</p><button class="btn" type="button" data-h="' + escH(h.id) + '" data-r="' + (r.refundable ? "rf" : "nr") + '">' + escH(tr("choose")) + "</button></div></div>";
  }
  function render() {
    var list = results.filter(function (h) { return free.checked ? h.refundable : (h.refundable || h.nonRefundable); });
    var c = $("hs-count"); c.hidden = false; c.textContent = list.length ? tr("results", { n: list.length }) : "";
    if (!list.length) { $("hs-results").innerHTML = ""; return msg(tr("no_results")); }
    msg("");
    $("hs-results").innerHTML = list.map(function (h) {
      var rates = free.checked ? [h.refundable] : [h.refundable, h.nonRefundable].filter(Boolean);
      var stars = h.stars ? '<span class="stars" aria-label="' + escH(tr("stars", { n: h.stars })) + '">' + "&#9733;".repeat(Math.min(5, Math.round(h.stars))) + "</span> " : "";
      return '<article class="hotel">' + (h.photo ? '<img loading="lazy" alt="" src="' + escH(h.photo) + '">' : "<div></div>") +
        "<div><h3>" + escH(h.name) + '</h3><p class="meta">' + stars + escH([h.address, h.city].filter(Boolean).join(", ")) + "</p>" + rates.map(function (r) { return rateRow(h, r); }).join("") + "</div></article>";
    }).join("");
    Array.prototype.forEach.call(document.querySelectorAll("#hs-results button[data-h]"), function (b) {
      b.addEventListener("click", function () {
        var h = results.filter(function (x) { return x.id === b.getAttribute("data-h"); })[0];
        var r = b.getAttribute("data-r") === "rf" ? h.refundable : h.nonRefundable;
        openCheckout(h, r);
      });
    });
  }

  // ---- checkout ----
  function openCheckout(h, r) {
    chosen = { hotel: h, rate: r };
    track("hotel_rate_selected", { refundable: r.refundable, hotel_id: h.id, price: r.total.amount, currency: r.total.currency, language: LANG });
    var n = Math.round((new Date(search.checkout + "T12:00:00") - new Date(search.checkin + "T12:00:00")) / 86400000);
    $("co-summary").innerHTML = '<dl class="kv"><dt>' + escH(tr("hotel")) + "</dt><dd>" + escH(h.name) + "</dd>" +
      "<dt>" + escH(tr("room")) + "</dt><dd>" + escH([r.name, r.board].filter(Boolean).join(", ")) + "</dd>" +
      "<dt>" + escH(tr("dates")) + "</dt><dd>" + escH(search.checkin + " \\u2192 " + search.checkout) + " (" + escH(n === 1 ? tr("night1") : tr("nights", { n: n })) + ")</dd>" +
      "<dt>" + escH(tr("price_label")) + "</dt><dd>" + escH(money(r.total.amount, r.total.currency)) + "</dd>" +
      "<dt>" + escH(tr("policy")) + "</dt><dd>" + escH(r.refundable ? (r.cancelDeadline ? tr("free_until", { d: deadline(r.cancelDeadline) }) : tr("policy_refundable")) : tr("policy_nonref")) + "</dd></dl>" +
      (r.payAtProperty && r.payAtProperty.length ? '<p class="small">' + escH(tr("pay_at_property", { list: r.payAtProperty.map(function (f) { return f.description + " " + money(f.amount, f.currency); }).join(", ") })) + "</p>" : "");
    $("co-nonref").hidden = r.refundable;
    $("co-form").hidden = false; $("pay-view").hidden = true; $("co-err").hidden = true;
    $("search-view").hidden = true; $("checkout-view").hidden = false; window.scrollTo(0, 0);
  }
  $("co-back").addEventListener("click", function () { $("checkout-view").hidden = true; $("search-view").hidden = false; $("targetElement").innerHTML = ""; });

  function loadSdk() {
    return new Promise(function (ok, bad) {
      if (window.LiteAPIPayment) return ok();
      var s = document.createElement("script"); s.src = SDK; s.onload = ok; s.onerror = bad; document.head.appendChild(s);
    });
  }
  $("co-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var g = { firstName: $("g-first").value.trim(), lastName: $("g-last").value.trim(), email: $("g-email").value.trim(), phone: $("g-phone").value.trim() };
    if (!g.firstName || !g.lastName || !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(g.email) || g.phone.replace(/\\D/g, "").length < 6) {
      var er = $("co-err"); er.hidden = false; er.textContent = tr("err_guest"); return;
    }
    var btn = $("co-go"); btn.disabled = true; btn.textContent = tr("preparing"); $("co-err").hidden = true;
    var r = chosen.rate, h = chosen.hotel;
    track("hotel_checkout_started", { refundable: r.refundable, hotel_id: h.id, price: r.total.amount, currency: r.total.currency, language: LANG });
    fetch("/api/hotels/prebook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ offerId: r.offerId }) })
      .then(function (res) { return res.json().then(function (d) { if (!res.ok || !d.secretKey) throw new Error(d.error || "prebook"); return d; }); })
      .then(function (p) {
        try {
          sessionStorage.setItem("peregrin_hotel_pending", JSON.stringify({ prebookId: p.prebookId, transactionId: p.transactionId, guest: g, lang: LANG, refundable: p.refundable, price: p.price, currency: p.currency, hotel: h.name }));
        } catch (err) {}
        if (p.priceChanged) { var pp = $("pay-price"); pp.hidden = false; pp.textContent = tr("price_changed", { p: money(p.price, p.currency) }); }
        $("co-form").hidden = true; $("pay-view").hidden = false;
        return loadSdk().then(function () {
          var ret = location.origin + "/hotels/complete?lang=" + LANG + "&pid=" + encodeURIComponent(p.prebookId) + "&tid=" + encodeURIComponent(p.transactionId);
          new window.LiteAPIPayment({
            publicKey: SANDBOX ? "sandbox" : "live",
            secretKey: p.secretKey,
            returnUrl: ret,
            targetElement: "#targetElement",
            appearance: { theme: "flat" },
            options: { business: { name: "Peregrin" } },
          }).handlePayment();
        });
      })
      .catch(function (err) {
        track("hotel_booking_failed", { stage: "prebook", error: String(err && err.message || err).slice(0, 200), language: LANG });
        var er = $("co-err"); er.hidden = false; er.textContent = tr("err_prebook");
        btn.disabled = false; btn.textContent = tr("continue");
      });
  });
})();
</script>`;
  return shell({ lang, title: t.title, meta: t.meta, canonical: self, alternates, headExtra, body, langNav });
}

// ------------------------------------------------------ /hotels/complete
export function renderCompletePage({ lang = "en", headExtra = "" }) {
  const t = HOTELS_COPY[lang] || HOTELS_COPY.en;
  const body = `
    <div class="card" id="cp">
      <h1 id="cp-h" style="font-size:26px;margin-top:0">${esc(t.confirming)}</h1>
      <p class="lede" id="cp-d">${esc(t.confirming_d)}</p>
    </div>
<script>
(function () {
  ${clientHelpers(lang)}
  var q = new URLSearchParams(location.search), pid = q.get("pid"), tid = q.get("tid") || "";
  function fail(h, d, err) {
    document.getElementById("cp-h").textContent = tr(h);
    document.getElementById("cp-d").textContent = tr(d, { ref: tid || pid || "-" });
    if (err) track("hotel_booking_failed", { stage: "book", error: String(err).slice(0, 200), language: LANG });
  }
  var doneKey = "peregrin_hotel_booked_" + tid;
  try { var done = sessionStorage.getItem(doneKey); if (done) return location.replace(done); } catch (e) {}
  if (q.get("redirect_status") === "failed") return fail("failed_h", "failed_d", "payment_failed");
  var pending = null;
  try { pending = JSON.parse(sessionStorage.getItem("peregrin_hotel_pending") || "null"); } catch (e) {}
  if (!pid || !tid || !pending || pending.prebookId !== pid) return fail("lost_h", "lost_d", "missing_pending");
  fetch("/api/hotels/book", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prebookId: pid, transactionId: tid, guest: pending.guest, lang: pending.lang || LANG }) })
    .then(function (r) { return r.json().then(function (d) { if (!r.ok || !d.url) throw new Error(d.error || "book"); return d; }); })
    .then(function (d) {
      track("hotel_booking_confirmed", { booking_id: d.bookingId, refundable: !!d.refundable, price: pending.price, currency: pending.currency, language: LANG });
      var url = d.url + (d.emailed ? "&emailed=1" : "");
      try { sessionStorage.setItem(doneKey, url); sessionStorage.removeItem("peregrin_hotel_pending"); } catch (e) {}
      location.replace(url);
    })
    .catch(function (err) { fail("failed_h", "failed_d", err && err.message || err); });
})();
</script>`;
  return shell({ lang, title: t.confirming.replace(/\.+$/, "") + " | Peregrin", noindex: true, headExtra, body });
}

// ------------------------------------------------- /hotels/booking/:id
function fmtStay(ymd, lang) {
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(ymd || "");
  try {
    return new Intl.DateTimeFormat(LOCALE[lang], { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
      .format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
  } catch { return ymd; }
}
function fmtMoney(a, c, lang) {
  try { return new Intl.NumberFormat(LOCALE[lang], { style: "currency", currency: c || "USD" }).format(a); } catch { return `${c} ${Number(a).toFixed(2)}`; }
}
const isCancelled = (bk) => /cancel/i.test(bk.status || "");
const nightsOf = (bk) => Math.round((Date.parse(bk.checkout + "T00:00:00Z") - Date.parse(bk.checkin + "T00:00:00Z")) / 86400000);
export function canSelfCancel(bk) {
  return !isCancelled(bk) && bk.refundable;
}
function policyHtml(bk, t) {
  if (isCancelled(bk)) return esc(t.already_cancelled);
  if (bk.refundable && bk.cancelDeadline) {
    const utc = new Date(bk.cancelDeadline).toISOString().replace("T", " ").slice(0, 16) + " UTC";
    return `<time data-utc="${esc(bk.cancelDeadline)}" data-tpl="policy_free">${esc(t.policy_free.replace("{d}", utc))}</time>`;
  }
  return esc(bk.refundable ? t.policy_refundable : t.policy_nonref);
}

export function renderBookingPage({ lang = "en", bk, links, headExtra = "", emailed = false }) {
  const t = HOTELS_COPY[lang] || HOTELS_COPY.en;
  const cancelled = isCancelled(bk);
  const n = nightsOf(bk);
  const body = `
    <p class="eyebrow">${esc(t.booking_title)}</p>
    <h1>${esc(bk.hotelName || t.hotel)}</h1>
    ${bk.hotelAddress ? `<p class="lede">${esc(bk.hotelAddress)}</p>` : ""}
    <p><span class="status ${cancelled ? "bad" : "ok"}" id="bk-status">${esc(t.status)}: ${esc(cancelled ? t.cancelled : t.confirmed)}</span></p>
    <p class="small" id="bk-emailed" hidden></p>
    <div class="card" style="margin-top:16px">
      <dl class="kv">
        <dt>${esc(t.ref)}</dt><dd id="bk-ref">${esc(bk.bookingId)}</dd>
        ${bk.hotelConfirmationCode ? `<dt>${esc(t.hotel_ref)}</dt><dd>${esc(bk.hotelConfirmationCode)}</dd>` : ""}
        <dt>${esc(t.dates)}</dt><dd>${esc(fmtStay(bk.checkin, lang))} &rarr; ${esc(fmtStay(bk.checkout, lang))}${n > 0 ? ` (${esc(n === 1 ? t.night1 : t.nights.replace("{n}", n))})` : ""}</dd>
        <dt>${esc(t.guest)}</dt><dd>${esc(bk.guestName)}</dd>
        ${bk.roomName ? `<dt>${esc(t.room)}</dt><dd>${esc([bk.roomName, bk.board].filter(Boolean).join(", "))}</dd>` : ""}
        ${bk.price ? `<dt>${esc(t.price)}</dt><dd>${esc(fmtMoney(bk.price, bk.currency, lang))}</dd>` : ""}
        <dt>${esc(t.policy)}</dt><dd>${policyHtml(bk, t)}</dd>
      </dl>
      <div class="actions">
        <a class="btn" href="${esc(links.pdf)}" target="_blank" rel="noopener">${esc(t.download)}</a>
        ${canSelfCancel(bk) ? `<a class="btn ghost" id="bk-cancel" href="${esc(links.cancel)}">${esc(t.cancel_link)}</a>` : ""}
      </div>
    </div>
<script>
(function () {
  ${clientHelpers(lang)}
  var q = new URLSearchParams(location.search);
  if (q.get("emailed") === "1") { var e = document.getElementById("bk-emailed"); e.hidden = false; e.textContent = tr("emailed", { e: ${js(bk.email || "")} }); }
})();
</script>`;
  return shell({ lang, title: `${t.booking_title} ${bk.bookingId} | Peregrin`, noindex: true, headExtra, body });
}

// ---------------------------------------------- /hotels/booking/:id/cancel
export function renderCancelPage({ lang = "en", bk, links, t: sig, headExtra = "" }) {
  const t = HOTELS_COPY[lang] || HOTELS_COPY.en;
  const cancelled = isCancelled(bk);
  const late = bk.refundable && bk.cancelDeadline && Date.parse(bk.cancelDeadline) < Date.now();
  let inner;
  if (cancelled) inner = `<p class="lede">${esc(t.already_cancelled)}</p>`;
  else if (!bk.refundable) inner = `<p class="lede">${esc(t.cancel_nonref)}</p>`;
  else inner = `
      <p class="lede" id="cx-q">${esc(t.cancel_q.replace("{h}", bk.hotelName).replace("{a}", fmtStay(bk.checkin, lang)).replace("{b}", fmtStay(bk.checkout, lang)))}</p>
      <p class="small">${policyHtml(bk, t)}</p>
      ${late ? `<p class="warn">${esc(t.cancel_late)}</p>` : ""}
      <div class="actions" id="cx-actions">
        <button class="btn" id="cx-go" type="button">${esc(t.cancel_btn)}</button>
        <a class="btn ghost" href="${esc(links.page)}">${esc(t.keep)}</a>
      </div>
      <div id="cx-result" hidden></div>`;
  const body = `
    <p class="eyebrow">${esc(t.booking_title)}</p>
    <p class="small">${esc(t.ref)}: <strong>${esc(bk.bookingId)}</strong></p>
    <h1 id="cx-h">${esc(t.cancel_h)}</h1>
    <div class="card">${inner}</div>
<script>
(function () {
  ${clientHelpers(lang)}
  var go = document.getElementById("cx-go"); if (!go) return;
  var ID = ${js(bk.bookingId)}, SIG = ${js(String(sig || ""))};
  go.addEventListener("click", function () {
    go.disabled = true; go.textContent = tr("cancelling");
    fetch("/api/hotels/booking/" + encodeURIComponent(ID) + "/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t: SIG }) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "cancel"); return d; }); })
      .then(function (d) {
        track("hotel_booking_cancelled", { booking_id: ID, status: d.status, refund_amount: d.refundAmount, currency: d.currency, language: LANG });
        document.getElementById("cx-h").textContent = tr("cancel_done_h");
        document.getElementById("cx-actions").hidden = true; document.getElementById("cx-q").hidden = true;
        var res = document.getElementById("cx-result"); res.hidden = false;
        res.innerHTML = (d.refundAmount != null ? '<p class="price">' + escH(tr("refund_amt", { p: money(d.refundAmount, d.currency) })) + "</p>" : "") +
          '<p><span class="status ok">' + escH(tr("refund_status", { s: /CHARGES/i.test(d.status) ? tr("cancelled_charges") : /CANCEL/i.test(d.status) ? tr("cancelled") : d.status })) + "</span></p>" +
          '<p class="small">' + escH(tr("refund_note")) + "</p>";
      })
      .catch(function (err) {
        track("hotel_booking_failed", { stage: "cancel", booking_id: ID, error: String(err && err.message || err).slice(0, 200), language: LANG });
        go.disabled = false; go.textContent = tr("cancel_btn");
        var res = document.getElementById("cx-result"); res.hidden = false;
        res.innerHTML = '<p class="msg err">' + escH(tr("cancel_err", { e: err && err.message || "" })) + "</p>";
      });
  });
})();
</script>`;
  return shell({ lang, title: `${t.cancel_h} | Peregrin`, noindex: true, headExtra, body });
}
