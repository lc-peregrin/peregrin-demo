// PDF reservation document.
//
// Extracted from server.js so the document's wording can be unit-tested: this
// copy is legally sensitive (it must never claim a ticket has been purchased)
// and previously had no coverage at all, because the rendered PDF compresses and
// subsets its fonts and can't be grepped.
//
// pdfkit gotchas that bite here (see CLAUDE.md): standard fonts use
// WinAnsiEncoding so arrows/checkmarks are drawn as vector paths, not text; and
// any transient style change must sit inside save()/restore() or it leaks into
// every later draw call.

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

  // Destination city for the header — the arrival point of the outbound slice,
  // falling back to the airport code and then the route summary.
  const outbound = (order.itinerary && order.itinerary[0]) || null;
  const lastSeg = outbound && outbound.segments && outbound.segments[outbound.segments.length - 1];
  const destCity =
    (lastSeg && (lastSeg.destination_name || lastSeg.destination_iata)) ||
    order.route_summary ||
    "your destination";
  const carrier = order.airline || "the operating carrier";

  // ---- Header: brand mark + trip title, reservation code top-right ----
  drawWingMark(doc, left, 48, brand.accent);
  doc.fontSize(10.5).fillColor(PDF_INK).font("Helvetica-Bold")
    .text(brand.name.toUpperCase(), left + 22, 50, { characterSpacing: 0.8 });

  doc.font("Helvetica").fontSize(9).fillColor(PDF_MUTED)
    .text("Reservation code", left, 50, { width, align: "right" });
  doc.font("Helvetica-Bold").fontSize(16).fillColor(brand.accent)
    .text(order.booking_reference || "-", left, 62, { width, align: "right" });

  doc.moveDown(2);
  // Reads like a normal airline itinerary while staying accurate: the code is
  // described as a reservation code, never as a purchased ticket.
  doc.font("Helvetica-Bold").fontSize(21).fillColor(PDF_INK)
    .text(`Your trip to ${destCity}`, left, 90, { width: width - 120 });
  doc.font("Helvetica").fontSize(10).fillColor(PDF_MUTED)
    .text(`Airline reservation code: ${order.booking_reference || "-"} (${carrier})`, left, doc.y + 3, { width });

  // ---- Status banner ----
  const bannerY = doc.y + 14;
  const bannerH = 46;
  const bannerBg = held ? "#e7f4ee" : "#eaf1fb";
  const bannerBorder = held ? "#c3e2d1" : "#c3d7f2";
  const bannerText = "Booking confirmed";
  const bannerSub = held
    ? "This reservation is held with the airline. An e-ticket is issued once you confirm and pay the fare."
    : "This reservation has been confirmed and an e-ticket issued.";
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

  // ---- Fine print ----
  // Order matters: purpose of the document, then the e-ticket condition (so the
  // held-vs-ticketed distinction is unmissable), then times, then travel docs.
  // The verification line stays — it is the whole trust mechanic.
  doc.moveDown(1.6);
  doc.save().lineWidth(1).strokeColor(PDF_LINE).moveTo(left, doc.y).lineTo(right, doc.y).stroke().restore();
  doc.moveDown(0.8);

  const footerFont = () => doc.font("Helvetica").fontSize(8.5).fillColor(PDF_MUTED);
  const note = (txt) => { footerFont().text(txt, left, doc.y, { width }); doc.moveDown(0.55); };

  note("This itinerary has been prepared to support a proof-of-onward-travel / visa application.");
  note("E-ticket issuance is subject to completion of payment.");
  note("All times shown are local to each airport.");
  note(
    "Please ensure your passport and any required visas are valid for travel. Entry requirements, visas and health " +
    "documentation vary by destination and can change without notice - confirm current requirements with the relevant " +
    "embassy, consulate or airline before travelling."
  );
  note(
    `Verification: this reservation can be independently verified with ${carrier} using the reservation code above. ` +
    "It reflects a genuine booking held in the airline's own system. It is a held airline reservation, not a purchased " +
    "ticket - an e-ticket is issued only once the fare is confirmed and paid."
  );
}

export { renderReservationPdf };
