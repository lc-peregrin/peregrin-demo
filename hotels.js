// /hotels: free-cancellation hotels via an affiliate partner (Trip.com).
//
// Peregrin does NOT hold, reserve or sell rooms. Duffel Stays is not approved,
// so the old in-house accommodation flow was removed. This page only sends the
// visitor to Trip.com, where they book a real refundable room themselves.
//
// Links are PLAIN trip.com URLs. Travelpayouts Drive (marker 555961, injected on
// every page via ANALYTICS_TAG) rewrites them into tracked affiliate links once
// the Trip.com program is approved; nothing here needs to change when it is.
// The link is a real <a> whose href is kept current as the form changes, so
// Drive sees an ordinary anchor click rather than a window.open().
//
// Trip.com only prefills a destination from its own numeric cityId (a name in
// the URL is ignored and the previous search is shown instead), so the city list
// is curated. Each id below was checked on 2026-11-22 by running a real search
// on trip.com and confirming the results page for that city with the dates and
// guest count prefilled. "Another city" opens Trip.com's hotel homepage rather
// than guessing a deep link.

export const HOTELS_PATHS = { en: "/hotels", es: "/es/hotels", ru: "/ru/hotels", hi: "/hi/hotels" };

export const TRIP_CITIES = [
  { id: 338, name: { en: "London", es: "Londres", ru: "Лондон", hi: "लंदन" } },
  { id: 192, name: { en: "Paris", es: "París", ru: "Париж", hi: "पेरिस" } },
  { id: 343, name: { en: "Rome", es: "Roma", ru: "Рим", hi: "रोम" } },
  { id: 357, name: { en: "Madrid", es: "Madrid", ru: "Мадрид", hi: "मैड्रिड" } },
  { id: 40795, name: { en: "Barcelona", es: "Barcelona", ru: "Барселона", hi: "बार्सिलोना" } },
  { id: 1231, name: { en: "Lisbon", es: "Lisboa", ru: "Лиссабон", hi: "लिस्बन" } },
  { id: 176, name: { en: "Amsterdam", es: "Ámsterdam", ru: "Амстердам", hi: "एम्स्टर्डम" } },
  { id: 220, name: { en: "Dubai", es: "Dubái", ru: "Дубай", hi: "दुबई" } },
  { id: 532, name: { en: "Istanbul", es: "Estambul", ru: "Стамбул", hi: "इस्तांबुल" } },
  { id: 359, name: { en: "Bangkok", es: "Bangkok", ru: "Бангкок", hi: "बैंकॉक" } },
];

export const TRIP_HOTELS_HOME = "https://www.trip.com/hotels/";

// Same shape the browser builds; exported so tests can pin the URL format.
export function tripHotelUrl({ cityId, checkin, checkout, guests }) {
  if (!cityId) return TRIP_HOTELS_HOME;
  const q = new URLSearchParams({ cityId: String(cityId), checkin, checkout, adult: String(guests || 1), crn: "1" });
  return `https://www.trip.com/hotels/list?${q.toString()}`;
}

// No em dashes anywhere (house rule). Never "hold", "fake" or "dummy"; never
// imply Peregrin holds or guarantees a room. RU and HI are first-pass
// translations, not yet native-speaker verified (flagged in STATE.md).
export const HOTELS_COPY = {
  en: {
    title: "Free-cancellation hotels for visa applications | Peregrin",
    meta: "Need proof of accommodation for a visa? Book a refundable hotel directly with our partner, choose free cancellation, and cancel before the deadline if plans change.",
    eyebrow: "Proof of accommodation",
    h1: "Free-cancellation hotels for your visa application",
    intro: "Many embassies ask for proof of accommodation. A refundable hotel booking is a simple, genuine way to show it. Book directly with our hotel partner, choose a room with free cancellation, and cancel before the deadline if your plans change.",
    city: "Destination city", other: "Another city", checkin: "Check-in", checkout: "Check-out", guests: "Guests",
    button: "Find free-cancellation hotels",
    disclosure: "Bookings are made directly with our partner. We may earn a small commission at no extra cost to you.",
    other_note: "For other cities, you'll choose the destination on our partner's site.",
    err_dates: "Check-out must be after check-in.",
    tips_h: "Before you book",
    tips: [
      "Filter for \"Free cancellation\" in the search results.",
      "Check the cancellation deadline before you book.",
      "Check exactly what your embassy or visa centre requires.",
    ],
    flight_h: "Need proof of onward travel too?",
    flight_p: "Get a verifiable flight reservation with a real airline booking reference.",
    flight_cta: "Reserve a flight",
    home: "/", help: "Help & FAQ", guides: "Guides",
  },
  es: {
    title: "Hoteles con cancelación gratuita para tu visado | Peregrin",
    meta: "¿Necesitas prueba de alojamiento para un visado? Reserva un hotel reembolsable directamente con nuestro socio, elige cancelación gratuita y cancela antes del plazo si cambian tus planes.",
    eyebrow: "Prueba de alojamiento",
    h1: "Hoteles con cancelación gratuita para tu solicitud de visado",
    intro: "Muchas embajadas piden prueba de alojamiento. Una reserva de hotel reembolsable es una forma sencilla y auténtica de demostrarlo. Reserva directamente con nuestro socio hotelero, elige una habitación con cancelación gratuita y cancela antes del plazo si cambian tus planes.",
    city: "Ciudad de destino", other: "Otra ciudad", checkin: "Entrada", checkout: "Salida", guests: "Huéspedes",
    button: "Buscar hoteles con cancelación gratuita",
    disclosure: "Las reservas se hacen directamente con nuestro socio. Podemos recibir una pequeña comisión sin coste adicional para ti.",
    other_note: "Para otras ciudades, elegirás el destino en la web de nuestro socio.",
    err_dates: "La salida debe ser posterior a la entrada.",
    tips_h: "Antes de reservar",
    tips: [
      "Filtra por \"Cancelación gratuita\" en los resultados.",
      "Comprueba el plazo de cancelación antes de reservar.",
      "Comprueba exactamente qué exige tu embajada o centro de visados.",
    ],
    flight_h: "¿También necesitas prueba de salida?",
    flight_p: "Consigue una reserva de vuelo verificable con un localizador real de la aerolínea.",
    flight_cta: "Reservar un vuelo",
    home: "/es", help: "Ayuda", guides: "Guías",
  },
  ru: {
    title: "Отели с бесплатной отменой для визы | Peregrin",
    meta: "Нужно подтверждение проживания для визы? Забронируйте отель с возвратом напрямую у нашего партнёра, выберите бесплатную отмену и отмените до срока, если планы изменятся.",
    eyebrow: "Подтверждение проживания",
    h1: "Отели с бесплатной отменой для вашего визового заявления",
    intro: "Многие посольства просят подтверждение проживания. Бронирование отеля с возвратом средств: простой и честный способ его показать. Бронируйте напрямую у нашего партнёра, выберите номер с бесплатной отменой и отмените до крайнего срока, если планы изменятся.",
    city: "Город назначения", other: "Другой город", checkin: "Заезд", checkout: "Выезд", guests: "Гости",
    button: "Найти отели с бесплатной отменой",
    disclosure: "Бронирование оформляется напрямую у нашего партнёра. Мы можем получить небольшую комиссию без дополнительных затрат для вас.",
    other_note: "Для других городов направление выбирается на сайте партнёра.",
    err_dates: "Дата выезда должна быть позже даты заезда.",
    tips_h: "Перед бронированием",
    tips: [
      "Включите фильтр \"Бесплатная отмена\" в результатах поиска.",
      "Проверьте крайний срок бесплатной отмены перед бронированием.",
      "Уточните, что именно требует ваше посольство или визовый центр.",
    ],
    flight_h: "Нужно ещё подтверждение вылета?",
    flight_p: "Получите подтверждаемую бронь авиабилета с настоящим кодом бронирования авиакомпании.",
    flight_cta: "Забронировать рейс",
    home: "/ru", help: "Помощь", guides: "Путеводители",
  },
  hi: {
    title: "वीज़ा आवेदन के लिए मुफ़्त रद्दीकरण वाले होटल | Peregrin",
    meta: "वीज़ा के लिए आवास का प्रमाण चाहिए? हमारे पार्टनर के साथ सीधे रिफ़ंडेबल होटल बुक करें, मुफ़्त रद्दीकरण चुनें, और योजना बदलने पर समय सीमा से पहले रद्द करें।",
    eyebrow: "आवास का प्रमाण",
    h1: "आपके वीज़ा आवेदन के लिए मुफ़्त रद्दीकरण वाले होटल",
    intro: "कई दूतावास आवास का प्रमाण मांगते हैं। रिफ़ंडेबल होटल बुकिंग इसे दिखाने का एक सरल और असली तरीका है। हमारे होटल पार्टनर के साथ सीधे बुक करें, मुफ़्त रद्दीकरण वाला कमरा चुनें, और योजना बदलने पर समय सीमा से पहले रद्द करें।",
    city: "गंतव्य शहर", other: "कोई अन्य शहर", checkin: "चेक-इन", checkout: "चेक-आउट", guests: "मेहमान",
    button: "मुफ़्त रद्दीकरण वाले होटल खोजें",
    disclosure: "बुकिंग सीधे हमारे पार्टनर के साथ होती है। हमें आपसे बिना किसी अतिरिक्त लागत के एक छोटा कमीशन मिल सकता है।",
    other_note: "अन्य शहरों के लिए, आप हमारे पार्टनर की साइट पर गंतव्य चुनेंगे।",
    err_dates: "चेक-आउट की तारीख चेक-इन के बाद होनी चाहिए।",
    tips_h: "बुक करने से पहले",
    tips: [
      "खोज परिणामों में \"Free cancellation\" (मुफ़्त रद्दीकरण) फ़िल्टर चुनें।",
      "बुक करने से पहले रद्दीकरण की समय सीमा जांचें।",
      "जांचें कि आपका दूतावास या वीज़ा केंद्र ठीक-ठीक क्या मांगता है।",
    ],
    flight_h: "आगे की यात्रा का प्रमाण भी चाहिए?",
    flight_p: "असली एयरलाइन बुकिंग रेफ़रेंस के साथ सत्यापन-योग्य फ्लाइट रिज़र्वेशन पाएं।",
    flight_cta: "फ्लाइट रिज़र्व करें",
    home: "/hi", help: "सहायता", guides: "गाइड",
  },
};

const LANG_LABEL = { en: "EN", es: "ES", ru: "RU", hi: "HI" };

function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function renderHotelsPage({ lang = "en", origin, headExtra = "" }) {
  const t = HOTELS_COPY[lang] || HOTELS_COPY.en;
  const self = origin + HOTELS_PATHS[lang];
  const alternates = Object.entries(HOTELS_PATHS)
    .map(([l, p]) => `<link rel="alternate" hreflang="${l}" href="${esc(origin + p)}">`)
    .concat(`<link rel="alternate" hreflang="x-default" href="${esc(origin + HOTELS_PATHS.en)}">`)
    .join("\n");
  const langNav = Object.entries(HOTELS_PATHS)
    .map(([l, p]) => l === lang
      ? `<span aria-current="page">${LANG_LABEL[l]}</span>`
      : `<a href="${p}" hreflang="${l}" lang="${l}">${LANG_LABEL[l]}</a>`)
    .join(" ");
  const cityOptions = TRIP_CITIES
    .map((c) => `<option value="${c.id}" data-en="${esc(c.name.en)}">${esc(c.name[lang] || c.name.en)}</option>`)
    .join("") + `<option value="" data-en="other">${esc(t.other)}</option>`;
  const guestOptions = [1, 2, 3, 4].map((n) => `<option value="${n}"${n === 1 ? " selected" : ""}>${n}</option>`).join("");

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(t.title)}</title>
<meta name="description" content="${esc(t.meta)}">
<link rel="canonical" href="${esc(self)}">
${alternates}
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#16283a">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Peregrin">
<meta property="og:title" content="${esc(t.title)}">
<meta property="og:description" content="${esc(t.meta)}">
<meta property="og:url" content="${esc(self)}">
${headExtra}
<style>
  @font-face { font-family:'Public Sans'; font-weight:400; font-display:swap; src:url('/fonts/publicsans-400-latin.woff2') format('woff2'); }
  @font-face { font-family:'Public Sans'; font-weight:700; font-display:swap; src:url('/fonts/publicsans-700-latin.woff2') format('woff2'); }
  :root { --ink:#16283a; --muted:#5c6b7c; --line:#e2e7ec; --bg:#f8f9fb; --accent:#1c6f8c;
    --accent-bg:#e8f2f5; --accent-dark:#124a5e; --gold:#c9922e; --gold-bg:#faf1e0; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:"Public Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
    color:var(--ink); background: radial-gradient(1100px 420px at 50% -140px, var(--accent-bg), transparent 70%), var(--bg); }
  .wrap { max-width:720px; margin:0 auto; padding:0 20px 80px; }
  header.site { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:22px 0 30px; flex-wrap:wrap; }
  .brand { display:flex; align-items:center; gap:9px; text-decoration:none; color:var(--ink); }
  .brand .mark { font-weight:800; letter-spacing:.04em; font-size:15px; text-transform:uppercase; }
  .nav { display:flex; gap:14px; align-items:center; font-size:13px; }
  .nav a { color:var(--accent); text-decoration:none; }
  .langs { color:var(--muted); font-size:12.5px; letter-spacing:.03em; }
  .langs span[aria-current] { color:var(--ink); font-weight:700; }
  .eyebrow { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; color:var(--accent); margin:0; }
  h1 { font-family:"Source Serif 4",Georgia,serif; font-size:34px; line-height:1.15; letter-spacing:-.02em; margin:8px 0 12px; }
  .lede { font-size:16.5px; color:var(--muted); line-height:1.65; margin:0 0 26px; }
  h2 { font-family:"Source Serif 4",Georgia,serif; font-size:21px; margin:34px 0 12px; }
  form.hs { background:#fff; border:1px solid var(--line); border-radius:14px; padding:20px; display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  form.hs .full { grid-column:1 / -1; }
  form.hs label { display:block; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin-bottom:6px; }
  form.hs input, form.hs select { width:100%; font:inherit; font-size:15px; padding:11px 12px; border:1px solid var(--line); border-radius:9px; color:var(--ink); background:#fff; }
  form.hs input:focus, form.hs select:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-bg); }
  .go { display:block; text-align:center; text-decoration:none; font-weight:700; font-size:15.5px; background:var(--ink); color:#fff; border-radius:9px; padding:14px 18px; }
  .go:hover { background:#0e1c2b; }
  .disclosure { font-size:12.5px; color:var(--muted); line-height:1.55; margin:0; }
  .note { font-size:13px; color:var(--muted); margin:0; }
  .err { font-size:13.5px; color:#8a3a2c; margin:0; font-weight:600; }
  ul.tips { margin:0; padding-left:20px; font-size:14.5px; line-height:1.75; }
  .flight { margin-top:34px; background:var(--gold-bg); border:1px solid #ecd9ad; border-radius:12px; padding:16px 18px; }
  .flight h2 { margin:0 0 6px; font-size:18px; }
  .flight p { margin:0 0 10px; font-size:14.5px; line-height:1.6; }
  .flight a { color:var(--accent-dark); font-weight:700; text-decoration:none; }
  footer.site { border-top:1px solid var(--line); margin-top:44px; padding:20px 0; font-size:12.5px; color:var(--muted); }
  footer.site a { color:var(--accent); text-decoration:none; }
  @media (max-width:560px) { form.hs { grid-template-columns:1fr; } h1 { font-size:28px; } }
</style>
</head>
<body>
  <div class="wrap">
    <header class="site">
      <a class="brand" href="${t.home}">
        <svg width="26" height="26" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <path d="M5 28C11 26 16 20 19 8" stroke="var(--accent)" stroke-width="4" stroke-linecap="round"/>
          <path d="M12 31C18 28 23 22 26 11" stroke="var(--accent)" stroke-width="4" stroke-linecap="round" opacity="0.55"/>
          <path d="M19 34C25 31 29 25 32 15" stroke="var(--gold)" stroke-width="4" stroke-linecap="round"/>
        </svg>
        <span class="mark">Peregrin</span>
      </a>
      <nav class="nav"><span class="langs">${langNav}</span><a href="/faq">${esc(t.help)}</a></nav>
    </header>

    <p class="eyebrow">${esc(t.eyebrow)}</p>
    <h1>${esc(t.h1)}</h1>
    <p class="lede">${esc(t.intro)}</p>

    <form class="hs" id="hotel-form" novalidate>
      <div class="full">
        <label for="hs-city">${esc(t.city)}</label>
        <select id="hs-city">${cityOptions}</select>
      </div>
      <div><label for="hs-in">${esc(t.checkin)}</label><input id="hs-in" type="date" required></div>
      <div><label for="hs-out">${esc(t.checkout)}</label><input id="hs-out" type="date" required></div>
      <div class="full"><label for="hs-guests">${esc(t.guests)}</label><select id="hs-guests">${guestOptions}</select></div>
      <p class="note full" id="hs-other-note" hidden>${esc(t.other_note)}</p>
      <p class="err full" id="hs-err" role="alert" hidden>${esc(t.err_dates)}</p>
      <a class="go full" id="hs-go" href="${TRIP_HOTELS_HOME}" target="_blank" rel="noopener sponsored">${esc(t.button)}</a>
      <p class="disclosure full">${esc(t.disclosure)}</p>
    </form>

    <h2>${esc(t.tips_h)}</h2>
    <ul class="tips">${t.tips.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>

    <div class="flight">
      <h2>${esc(t.flight_h)}</h2>
      <p>${esc(t.flight_p)}</p>
      <a href="${t.home}">${esc(t.flight_cta)} &rarr;</a>
    </div>

    <footer class="site">
      <a href="${t.home}">Peregrin</a> &middot; <a href="/blog">${esc(t.guides)}</a> &middot; <a href="/faq">${esc(t.help)}</a> &middot; <a href="mailto:hello@peregrin.travel">hello@peregrin.travel</a>
    </footer>
  </div>
<script>
(function () {
  var LANG = ${JSON.stringify(lang)};
  var city = document.getElementById("hs-city");
  var inp = document.getElementById("hs-in");
  var out = document.getElementById("hs-out");
  var guests = document.getElementById("hs-guests");
  var go = document.getElementById("hs-go");
  var err = document.getElementById("hs-err");
  var otherNote = document.getElementById("hs-other-note");

  // Dates in the visitor's own timezone, never a hardcoded date.
  function ymd(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function addDays(n) { var d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return d; }
  var today = ymd(addDays(0));
  inp.min = today; out.min = ymd(addDays(1));
  inp.value = ymd(addDays(7)); out.value = ymd(addDays(10));

  function nights() {
    var a = new Date(inp.value + "T12:00:00"), b = new Date(out.value + "T12:00:00");
    return Math.round((b - a) / 86400000);
  }
  function valid() { return !!inp.value && !!out.value && inp.value >= today && nights() > 0; }

  // Keep the anchor's href current so the link Drive sees (and rewrites) is
  // always the real destination at the moment of the click.
  function sync() {
    if (inp.value) out.min = inp.value;
    otherNote.hidden = !!city.value;
    if (!city.value) { go.href = ${JSON.stringify(TRIP_HOTELS_HOME)}; return; }
    var q = new URLSearchParams({ cityId: city.value, checkin: inp.value, checkout: out.value, adult: guests.value, crn: "1" });
    go.href = "https://www.trip.com/hotels/list?" + q.toString();
  }
  [city, inp, out, guests].forEach(function (el) { el.addEventListener("change", function () { err.hidden = true; sync(); }); });
  sync();

  go.addEventListener("click", function (e) {
    if (city.value && !valid()) { e.preventDefault(); err.hidden = false; return; }
    var opt = city.options[city.selectedIndex];
    if (window.peregrinTrack) window.peregrinTrack("hotel_search_submitted", {
      city: opt ? opt.getAttribute("data-en") : "", nights: city.value ? nights() : null,
      guests: Number(guests.value), language: LANG, partner: "trip.com",
    });
  });
  // Enter in a field acts like pressing the button.
  document.getElementById("hotel-form").addEventListener("submit", function (e) { e.preventDefault(); go.click(); });
})();
</script>
</body>
</html>`;
}
