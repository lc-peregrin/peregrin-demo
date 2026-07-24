// Airline logo fetching for the reservation PDF.
//
// Duffel exposes carrier logos on the airline object (`logo_symbol_url`,
// `logo_lockup_url`). They are served as SVG only — there is no PNG variant —
// so they are drawn into the PDF as vectors by pdf.js rather than embedded as
// images. See CLAUDE.md: pdfkit itself only takes PNG/JPEG.
//
// The document must generate even when this fails, so every path here is
// best-effort: short timeout, size cap, in-memory cache (including negative
// results, so a carrier with no logo isn't refetched on every PDF), and a null
// return that the renderer treats as "draw the IATA code instead".

const TIMEOUT_MS = 2500;
const MAX_BYTES = 200_000;

// url -> svg string | null. Process-lifetime cache; the set of airlines in play
// is small and their logos never change mid-process.
const cache = new Map();

async function fetchLogoSvg(url) {
  if (!url || typeof url !== "string") return null;
  if (cache.has(url)) return cache.get(url);

  let svg = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      const text = await res.text();
      // Guard against an error page or an unexpectedly huge asset being handed
      // to the SVG parser.
      if (text.length <= MAX_BYTES && /<svg[\s>]/i.test(text)) svg = text;
    }
  } catch {
    svg = null; // offline, DNS, timeout, abort — all mean "no logo".
  }

  cache.set(url, svg);
  return svg;
}

// Walks the order's segments and resolves one logo per distinct operating
// carrier, keyed by IATA code so the renderer can look it up per leg.
async function collectAirlineLogos(order) {
  const wanted = new Map(); // iata -> url
  for (const slice of order?.itinerary || []) {
    for (const seg of slice.segments || []) {
      if (seg.airline_iata && seg.airline_logo_url && !wanted.has(seg.airline_iata)) {
        wanted.set(seg.airline_iata, seg.airline_logo_url);
      }
    }
  }
  const entries = await Promise.all(
    [...wanted].map(async ([iata, url]) => [iata, await fetchLogoSvg(url)])
  );
  const logos = {};
  for (const [iata, svg] of entries) if (svg) logos[iata] = svg;
  return logos;
}

export { fetchLogoSvg, collectAirlineLogos };
