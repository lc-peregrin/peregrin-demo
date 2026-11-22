// "Hotel booking confirmation" PDF, in the same visual language as the flight
// reservation document (pdf.js): wing mark, reference top right, status
// banner, detail block, fine print.
//
// pdfkit gotchas (CLAUDE.md): the standard fonts are WinAnsi, so text that may
// carry other scripts (hotel names, addresses) goes through winAnsi(), and every
// transient style sits inside save()/restore(). The document is English in every
// language because the built-in fonts cannot draw Cyrillic or Devanagari.
// No em dashes anywhere.

const INK = "#16283a";
const MUTED = "#5c6b7c";
const LINE = "#d8dee5";
const ACCENT = "#1c6f8c";

function drawWingMark(doc, x, y) {
  doc.save();
  doc.lineWidth(2.2).lineCap("round");
  doc.strokeColor(ACCENT).opacity(1)
    .moveTo(x, y + 11).bezierCurveTo(x + 3, y + 9, x + 6, y + 5, x + 7.5, y).stroke();
  doc.strokeColor(ACCENT).opacity(0.55)
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

// Keep Latin-1, map common typography, drop anything the font cannot draw.
export function winAnsi(s) {
  return String(s == null ? "" : s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-").replace(/…/g, "...")
    .normalize("NFC")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "")
    .replace(/\s{2,}/g, " ").trim();
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Stay dates are calendar dates (no timezone): format from the digits.
export function stayDate(ymd) {
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(ymd || "");
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${DOW[d.getUTCDay()]} ${+m[3]} ${MON[+m[2] - 1]} ${m[1]}`;
}
export function utcStamp(iso) {
  // LiteAPI timestamps ("2026-11-22T12:26:19") are UTC with no marker; read
  // them as UTC rather than as server-local time.
  const s = String(iso || "");
  const d = new Date(/T\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(s) ? s + "Z" : s);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
export function nightsBetween(a, b) {
  const x = Date.parse(a + "T00:00:00Z"), y = Date.parse(b + "T00:00:00Z");
  return Number.isNaN(x) || Number.isNaN(y) ? null : Math.round((y - x) / 86400000);
}

export function renderHotelPdf(doc, bk) {
  const left = 50, right = 545, width = right - left;
  const cancelled = /cancel/i.test(bk.status);

  drawWingMark(doc, left, 48);
  doc.fontSize(10.5).fillColor(INK).font("Helvetica-Bold").text("PEREGRIN", left + 22, 50, { characterSpacing: 0.8 });

  doc.font("Helvetica").fontSize(9).fillColor(MUTED).text("Booking reference", left, 50, { width, align: "right" });
  doc.font("Helvetica-Bold").fontSize(16).fillColor(ACCENT).text(winAnsi(bk.bookingId) || "-", left, 62, { width, align: "right" });
  if (bk.hotelConfirmationCode) {
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED)
      .text(`Hotel confirmation: ${winAnsi(bk.hotelConfirmationCode)}`, left, 82, { width, align: "right" });
  }

  doc.font("Helvetica-Bold").fontSize(21).fillColor(INK).text("Hotel booking confirmation", left, 100, { width: width - 140 });
  doc.font("Helvetica-Bold").fontSize(13).fillColor(INK).text(winAnsi(bk.hotelName) || "Hotel", left, doc.y + 6, { width });
  if (bk.hotelAddress) doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(winAnsi(bk.hotelAddress), left, doc.y + 2, { width });
  if (bk.createdAt) {
    const s = utcStamp(bk.createdAt);
    if (s) doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(`Issued ${s}`, left, doc.y + 2, { width });
  }

  // Status banner
  const bannerY = doc.y + 14, bannerH = 46;
  const bg = cancelled ? "#fbeeee" : "#e7f4ee", border = cancelled ? "#efc9c9" : "#c3e2d1";
  doc.roundedRect(left, bannerY, width, bannerH, 8).fillAndStroke(bg, border);
  if (!cancelled) drawCheck(doc, left + 22, bannerY + bannerH / 2, "#1f7a5c");
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(12.5)
    .text(cancelled ? "Cancelled" : "Confirmed", left + 40, bannerY + 9, { width: width - 60 });
  doc.fillColor(MUTED).font("Helvetica").fontSize(9.5).text(
    cancelled
      ? "This hotel booking has been cancelled."
      : "This is a confirmed hotel booking, made with the property through our booking partner.",
    left + 40, bannerY + 25, { width: width - 60 });
  doc.y = bannerY + bannerH + 22;

  // Stay block
  const section = (t) => { doc.font("Helvetica-Bold").fontSize(10).fillColor(ACCENT).text(t, left, doc.y, { characterSpacing: 0.8 }); doc.moveDown(0.5); };
  section("YOUR STAY");
  const boxTop = doc.y, pad = 16, col = (width - pad * 2) / 2;
  const n = nightsBetween(bk.checkin, bk.checkout);
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text("CHECK-IN", left + pad, boxTop + 14, { width: col });
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text("CHECK-OUT", left + pad + col, boxTop + 14, { width: col, align: "right" });
  doc.font("Helvetica-Bold").fontSize(13).fillColor(INK).text(stayDate(bk.checkin), left + pad, boxTop + 27, { width: col });
  doc.font("Helvetica-Bold").fontSize(13).fillColor(INK).text(stayDate(bk.checkout), left + pad + col, boxTop + 27, { width: col, align: "right" });
  let y = boxTop + 48;
  const roomLine = [winAnsi(bk.roomName), winAnsi(bk.board), n ? `${n} night${n === 1 ? "" : "s"}` : ""].filter(Boolean).join("  ·  ");
  if (roomLine) { doc.font("Helvetica").fontSize(9.5).fillColor(INK).text(roomLine, left + pad, y, { width: width - pad * 2 }); y = doc.y + 2; }
  doc.roundedRect(left, boxTop, width, y + 12 - boxTop, 8).lineWidth(1).stroke(LINE);
  doc.y = y + 26;

  section("GUEST");
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(winAnsi(bk.guestName) || "Not provided", left, doc.y);
  doc.moveDown(1);

  if (bk.price) {
    section("PRICE");
    doc.font("Helvetica").fontSize(10).fillColor(INK)
      .text(`${bk.currency} ${bk.price.toFixed(2)} paid, including taxes collected at booking.`, left, doc.y, { width });
    doc.moveDown(1);
  }

  section("CANCELLATION POLICY");
  let policy;
  if (cancelled) policy = "This booking has been cancelled. Any refund is returned to the card used to pay.";
  else if (bk.refundable && bk.cancelDeadline) policy = `Free cancellation until ${utcStamp(bk.cancelDeadline)}. After that, the hotel's cancellation charges apply.`;
  else if (bk.refundable) policy = "Refundable under the hotel's cancellation policy.";
  else policy = "Non-refundable. This booking cannot be cancelled for a refund.";
  doc.font("Helvetica").fontSize(10).fillColor(INK).text(policy, left, doc.y, { width });

  doc.moveDown(1.6);
  doc.save().lineWidth(1).strokeColor(LINE).moveTo(left, doc.y).lineTo(right, doc.y).stroke().restore();
  doc.moveDown(0.8);
  const note = (t) => { doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(t, left, doc.y, { width }); doc.moveDown(0.55); };
  note("This is a real hotel booking. Present this confirmation and the guest's passport or ID at check-in.");
  note("Check-in and check-out times are set by the property. Taxes or fees marked as payable at the property are paid there and are not included above.");
  note("Visa and embassy requirements vary. Check exactly what your embassy or visa centre asks for.");
  note("Booked through Peregrin with our hotel booking partner, Nuitee (LiteAPI). Questions: hello@peregrin.travel");
}
