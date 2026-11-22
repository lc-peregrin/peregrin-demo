// Launch waitlist form. Flight reservations are paused while Peregrin adds a
// new airline partner, so a buyer who reaches a dead end can leave an email for
// 20% off when reservations are back. Nothing is stored in the browser: the
// form posts to /api/launch-waitlist, which stores the signup with the email
// provider and sends the confirmation.
//
// Usage: any element with data-waitlist="<source>" is mounted on load
// (data-variant="compact" for the small version). The checkout dead end calls
// PeregrinWaitlist.mount(el, { source, route, date, email }) directly.
// Copy: EN, ES, RU, HI. No em dashes. Never claims holds are available.
(function () {
  var COPY = {
    en: {
      title: "Reservations are paused while we add a new airline partner.",
      body: "Leave your email and we'll send you 20% off when we're back.",
      compact: "Flight reservations are paused while we add a new airline partner. Leave your email for 20% off when we're back.",
      email: "Email", date: "Travel date (optional)", route: "Route", btn: "Email me when you're back",
      consent: "We'll only email you about Peregrin's launch. Unsubscribe any time.",
      ok: "You're on the list. We've sent a confirmation to {e}.",
      bad: "Please enter a valid email address.", err: "We couldn't save that just now. Please try again.",
      sending: "Saving...",
    },
    es: {
      title: "Las reservas están en pausa mientras añadimos un nuevo socio aéreo.",
      body: "Déjanos tu correo y te enviaremos un 20% de descuento cuando volvamos.",
      compact: "Las reservas de vuelo están en pausa mientras añadimos un nuevo socio aéreo. Déjanos tu correo y te daremos un 20% de descuento cuando volvamos.",
      email: "Correo electrónico", date: "Fecha de viaje (opcional)", route: "Ruta", btn: "Quiero el aviso",
      consent: "Solo te escribiremos sobre el lanzamiento de Peregrin. Puedes darte de baja cuando quieras.",
      ok: "Ya estás en la lista. Te hemos enviado una confirmación a {e}.",
      bad: "Introduce un correo electrónico válido.", err: "No pudimos guardarlo ahora. Inténtalo de nuevo.",
      sending: "Guardando...",
    },
    ru: {
      title: "Бронирование приостановлено, пока мы подключаем нового авиапартнёра.",
      body: "Оставьте email, и мы пришлём скидку 20%, когда возобновим работу.",
      compact: "Бронирование рейсов приостановлено, пока мы подключаем нового авиапартнёра. Оставьте email и получите скидку 20%, когда мы вернёмся.",
      email: "Эл. почта", date: "Дата поездки (необязательно)", route: "Маршрут", btn: "Сообщите, когда вернётесь",
      consent: "Мы напишем только о запуске Peregrin. Отписаться можно в любой момент.",
      ok: "Вы в списке. Мы отправили подтверждение на {e}.",
      bad: "Введите корректный адрес эл. почты.", err: "Не удалось сохранить. Попробуйте ещё раз.",
      sending: "Сохраняем...",
    },
    hi: {
      title: "नए एयरलाइन पार्टनर को जोड़ने तक आरक्षण रुके हुए हैं।",
      body: "अपना ईमेल दें, हम वापस आने पर आपको 20% की छूट भेजेंगे।",
      compact: "नए एयरलाइन पार्टनर को जोड़ने तक फ्लाइट आरक्षण रुके हुए हैं। अपना ईमेल दें और वापस आने पर 20% की छूट पाएं।",
      email: "ईमेल", date: "यात्रा की तारीख (वैकल्पिक)", route: "रूट", btn: "वापस आने पर मुझे ईमेल करें",
      consent: "हम आपको केवल Peregrin के लॉन्च के बारे में ईमेल करेंगे। कभी भी अनसब्सक्राइब करें।",
      ok: "आप सूची में हैं। हमने {e} पर पुष्टि भेज दी है।",
      bad: "कृपया सही ईमेल पता दर्ज करें।", err: "अभी सेव नहीं हो सका। कृपया फिर कोशिश करें।",
      sending: "सेव हो रहा है...",
    },
  };
  function lang() {
    var l = (document.documentElement.lang || "en").slice(0, 2);
    try { if (!COPY[l]) l = (localStorage.getItem("peregrin_lang") || "en").slice(0, 2); } catch (e) {}
    return COPY[l] ? l : "en";
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function track(n, p) { try { if (window.peregrinTrack) window.peregrinTrack(n, p || {}); } catch (e) {} }

  var CSS = ".wl{background:#fff;border:1px solid #e2e7ec;border-radius:14px;padding:18px 18px 14px;margin:16px 0;text-align:left;font:inherit;color:#16283a}" +
    ".wl h3{margin:0 0 4px;font-size:16px;line-height:1.35}.wl p{margin:0 0 12px;font-size:14px;line-height:1.55;color:#5c6b7c}" +
    ".wl form{display:grid;grid-template-columns:1fr 1fr;gap:10px}.wl .full{grid-column:1/-1}" +
    ".wl label{display:block;font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#5c6b7c;margin-bottom:5px}" +
    ".wl input{width:100%;box-sizing:border-box;font:inherit;font-size:15px;padding:10px 11px;border:1px solid #e2e7ec;border-radius:9px;color:#16283a;background:#fff}" +
    ".wl input[readonly]{background:#f8f9fb}.wl button{font:inherit;font-weight:700;font-size:15px;background:#16283a;color:#fff;border:none;border-radius:9px;padding:12px 16px;cursor:pointer}" +
    ".wl button:disabled{opacity:.6}.wl .consent{font-size:12.5px;margin:2px 0 0}.wl .msg{font-size:14px;font-weight:600;margin:4px 0 0}.wl .msg.err{color:#8a3a2c}.wl .msg.ok{color:#1f7a5c}" +
    ".wl .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}" +
    ".wl.compact{padding:14px 16px 12px;background:#e8f2f5;border-color:#cfe3ea}.wl.compact form{grid-template-columns:1fr auto}.wl.compact p{color:#124a5e;font-weight:600}" +
    "@media(max-width:560px){.wl form,.wl.compact form{grid-template-columns:1fr}}";
  var styled = false;
  function style() { if (styled) return; styled = true; var s = document.createElement("style"); s.textContent = CSS; document.head.appendChild(s); }

  function mount(el, opts) {
    if (!el) return;
    opts = opts || {};
    style();
    var L = lang(), t = COPY[L], compact = opts.variant === "compact";
    var source = opts.source || el.getAttribute("data-waitlist") || location.pathname;
    var route = opts.route || "";
    el.className = (el.className ? el.className + " " : "") + "wl" + (compact ? " compact" : "");
    el.innerHTML = (compact ? "<p>" + esc(t.compact) + "</p>" : "<h3>" + esc(t.title) + "</h3><p>" + esc(t.body) + "</p>") +
      '<form novalidate>' +
      '<div class="' + (compact ? "" : "full") + '"><label>' + esc(t.email) + '</label><input type="email" name="email" autocomplete="email" required value="' + esc(opts.email || "") + '"></div>' +
      (compact ? "" :
        '<div><label>' + esc(t.date) + '</label><input type="date" name="travel_date" value="' + esc(opts.date || "") + '"></div>' +
        '<div><label>' + esc(t.route) + '</label><input type="text" name="route" readonly value="' + esc(route) + '"></div>') +
      '<div class="hp" aria-hidden="true"><input type="text" name="website" tabindex="-1" autocomplete="off"></div>' +
      '<div class="' + (compact ? "" : "full") + '" style="align-self:end"><button type="submit">' + esc(t.btn) + "</button></div>" +
      '<p class="consent full">' + esc(t.consent) + "</p>" +
      '<p class="msg full" role="status" hidden></p></form>';
    var form = el.querySelector("form"), msg = el.querySelector(".msg"), btn = el.querySelector("button");
    function say(text, cls) { msg.hidden = false; msg.className = "msg full " + cls; msg.textContent = text; }
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = form.email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return say(t.bad, "err");
      btn.disabled = true; var label = btn.textContent; btn.textContent = t.sending;
      var body = { email: email, travel_date: form.travel_date ? form.travel_date.value : "", route: route, source: source, lang: L, website: form.website.value };
      fetch("/api/launch-waitlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (d) { if (!r.ok || !d.ok) throw new Error(d.error || "save"); return d; }); })
        .then(function () {
          track("waitlist_signup", { source: source, route: route || null, language: L, has_travel_date: !!body.travel_date });
          btn.textContent = label;
          form.querySelectorAll("input,button").forEach(function (x) { x.disabled = true; });
          say(t.ok.replace("{e}", email), "ok");
        })
        .catch(function () { btn.disabled = false; btn.textContent = label; say(t.err, "err"); });
    });
  }

  window.PeregrinWaitlist = { mount: mount };
  function auto() {
    document.querySelectorAll("[data-waitlist]").forEach(function (el) {
      if (!el.getAttribute("data-mounted")) { el.setAttribute("data-mounted", "1"); mount(el, { variant: el.getAttribute("data-variant") || "" }); }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", auto); else auto();
})();
