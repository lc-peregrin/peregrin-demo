// On-page SEO targets, transcribed from SEO_TARGET_MAP.md in the project root.
//
// That file is the spec and lives outside this deployed folder, so the values
// are mirrored here rather than read at runtime. When the map changes, change
// this file: the test suite checks every entry against the map's own rules
// (title < 60, meta < 155, exactly one H1), so a bad transcription fails loudly.
//
// The important behaviour in here is SELF-ACTIVATING INTERNAL LINKS. The map
// prescribes links to guides that do not exist yet. Rendering those today would
// put internal links to 404s on five live pages, which is worse for crawling
// than no link at all. So every mapped link is filtered through liveLinks()
// against the pages that actually exist, and switches itself on the moment its
// guide is published. Nobody has to remember to wire it up.

// Routes that exist regardless of what is in content/blog.
const STATIC_ROUTES = new Set(["/", "/blog", "/faq", "/sample-reservation", "/privacy", "/verify"]);

export const SEO_TARGETS = {
  "/": {
    keyword: "proof of onward travel",
    intent: "transactional",
    title: "Verifiable Flight Reservations for Visa & Onward Travel",
    meta: "Get a genuine, verifiable flight reservation in minutes: a real airline booking with a PNR you can verify for visa, immigration, and onward-travel proof.",
    h1: "Get a verifiable flight reservation in minutes",
    internalLinks: ["/blog", "/blog/dummy-ticket-visa-application", "/blog/flight-reservation-schengen-visa"],
    schema: ["Organization", "WebSite"],
  },
  "/blog": {
    keyword: "proof of onward travel guides",
    intent: "informational hub",
    title: "Proof of Onward Travel Guides by Country | Peregrin",
    meta: "Practical, up-to-date guides on proof of onward travel, visas, and entry rules by country. Know exactly what to show at check-in and immigration.",
    h1: "Travel and visa guides",
    internalLinks: [
      "/blog/dummy-ticket-visa-application",
      "/blog/flight-itinerary-for-visa-application",
      "/blog/digital-nomad-visa-onward-travel",
    ],
    schema: ["Blog", "BreadcrumbList"],
  },
  "/sample-reservation": {
    keyword: "sample flight reservation for visa",
    intent: "evaluation",
    title: "See a Sample Flight Reservation (Real PNR) | Peregrin",
    meta: "See exactly what a Peregrin reservation looks like: a real airline booking reference you can verify, formatted as proof for a visa and airline check-in.",
    h1: "A sample reservation",
    internalLinks: ["/", "/blog/dummy-ticket-visa-application"],
    schema: ["WebPage"],
  },
  "/privacy": {
    intent: "utility",
    title: "Privacy Policy | Peregrin",
    meta: "How Peregrin collects, uses, and protects your personal information when you use our reservation service.",
    h1: "Privacy Policy",
    internalLinks: [],
    schema: ["WebPage"],
  },

  // ---- pillar guides ----
  "/blog/dummy-ticket-visa-application": {
    keyword: "dummy ticket for visa",
    title: "Dummy Ticket for a Visa: The Legit Way (2026)",
    meta: '"Dummy ticket" advice is often risky. Here\'s what embassies actually want and how to show a real, verifiable onward flight without buying one.',
    h1: "Dummy Ticket for a Visa Application: What It Really Means in 2026",
    internalLinks: [
      "/blog/flight-itinerary-for-visa-application",
      "/blog/flight-reservation-schengen-visa",
      "/blog/proof-of-onward-travel-thailand",
    ],
  },
  "/blog/flight-itinerary-for-visa-application": {
    keyword: "flight itinerary for visa application",
    title: "Flight Itinerary for a Visa Application (2026)",
    meta: "Visa forms often ask for a flight itinerary. Here's what it means, why not to buy the ticket first, and how to show a verifiable reservation instead.",
    h1: "Flight Itinerary for a Visa Application: The Safe Way in 2026",
    internalLinks: [
      "/blog/dummy-ticket-visa-application",
      "/blog/flight-reservation-schengen-visa",
      "/blog/proof-of-onward-travel-thailand",
    ],
  },
  "/blog/digital-nomad-visa-onward-travel": {
    keyword: "digital nomad visa proof of onward travel",
    title: "Digital Nomad Visas & Proof of Onward Travel (2026)",
    meta: "Dozens of countries now offer nomad visas. Here's where proof of onward travel and entry checks fit, and how to cover them without buying a ticket.",
    h1: "Digital Nomad Visas and Proof of Onward Travel in 2026",
    internalLinks: [
      "/blog/proof-of-onward-travel-thailand",
      "/blog/proof-of-onward-travel-bali-indonesia",
      "/blog/dummy-ticket-visa-application",
    ],
  },
  "/blog/flight-reservation-schengen-visa": {
    keyword: "flight reservation for Schengen visa",
    title: "Flight Reservation for a Schengen Visa (2026)",
    meta: "Schengen embassies advise against buying a ticket before approval. Here's how to show a verifiable flight reservation for your Schengen visa instead.",
    h1: "Flight Reservation for a Schengen Visa: Why You Should Not Buy the Ticket Yet",
    internalLinks: [
      "/blog/dummy-ticket-visa-application",
      "/blog/flight-itinerary-for-visa-application",
      "/blog/proof-of-onward-travel-thailand",
    ],
  },

  // ---- country / destination guides ----
  "/blog/proof-of-onward-travel-thailand": {
    keyword: "proof of onward travel Thailand",
    title: "Proof of Onward Travel for Thailand (2026)",
    meta: "Thailand asks visa-exempt visitors for proof of onward travel. Here's what's required, how it's checked, and how to show it without buying a ticket.",
    h1: "Proof of Onward Travel for Thailand: What You Actually Need in 2026",
    internalLinks: [
      "/blog/dummy-ticket-visa-application",
      "/blog/proof-of-onward-travel-vietnam",
      "/blog/onward-ticket-philippines",
    ],
  },
  "/blog/proof-of-onward-travel-vietnam": {
    keyword: "proof of onward travel Vietnam",
    title: "Proof of Onward Travel for Vietnam (2026)",
    meta: "Vietnam's e-visa is generous, but airlines still check for onward travel at the gate. Here's what you need and how to show it without buying a ticket.",
    h1: "Proof of Onward Travel for Vietnam: What You Actually Need in 2026",
    internalLinks: [
      "/blog/proof-of-onward-travel-thailand",
      "/blog/dummy-ticket-visa-application",
      "/blog/proof-of-onward-travel-bali-indonesia",
    ],
  },
  "/blog/proof-of-onward-travel-bali-indonesia": {
    keyword: "proof of onward travel Bali",
    title: "Proof of Onward Travel for Bali & Indonesia (2026)",
    meta: "Flying to Bali? Indonesia and the airlines want proof of onward travel. Here's exactly what to show at check-in and immigration, without overspending.",
    h1: "Proof of Onward Travel for Bali and Indonesia: What You Actually Need in 2026",
    internalLinks: [
      "/blog/proof-of-onward-travel-thailand",
      "/blog/proof-of-onward-travel-vietnam",
      "/blog/dummy-ticket-visa-application",
    ],
  },
  "/blog/onward-ticket-philippines": {
    keyword: "onward ticket Philippines",
    title: "Onward Ticket for the Philippines (2026)",
    meta: "The Philippines rule airlines actually enforce: no onward ticket, no boarding. Here's what counts as proof and how to get it without buying a flight.",
    h1: "Onward Ticket for the Philippines: The Rule Airlines Actually Enforce in 2026",
    internalLinks: [
      "/blog/proof-of-onward-travel-thailand",
      "/blog/proof-of-onward-travel-vietnam",
      "/blog/dummy-ticket-visa-application",
    ],
  },
  "/blog/proof-of-onward-travel-colombia": {
    keyword: "proof of onward travel Colombia",
    title: "Proof of Onward Travel for Colombia (2026)",
    meta: "Colombia is one of the places airlines really do deny boarding without onward proof. Here's what to show and how to do it without buying a ticket.",
    h1: "Proof of Onward Travel for Colombia: What You Actually Need in 2026",
    internalLinks: [
      "/blog/proof-of-onward-travel-peru",
      "/blog/proof-of-onward-travel-mexico",
      "/blog/dummy-ticket-visa-application",
    ],
  },
  "/blog/proof-of-onward-travel-mexico": {
    keyword: "proof of onward travel Mexico",
    title: "Proof of Onward Travel for Mexico (2026)",
    meta: "Mexico and the airlines can ask for onward travel on arrival. Here's what's required, who gets asked, and how to show it without buying a ticket.",
    h1: "Proof of Onward Travel for Mexico: What You Actually Need in 2026",
    internalLinks: [
      "/blog/proof-of-onward-travel-costa-rica",
      "/blog/proof-of-onward-travel-colombia",
      "/blog/dummy-ticket-visa-application",
    ],
  },
  "/blog/proof-of-onward-travel-costa-rica": {
    keyword: "proof of onward travel Costa Rica",
    title: "Proof of Onward Travel for Costa Rica (2026)",
    meta: "Costa Rica is famous for onward-travel checks at check-in. Here's what officers and airlines want and how to show it without buying a ticket.",
    h1: "Proof of Onward Travel for Costa Rica: What You Actually Need in 2026",
    internalLinks: [
      "/blog/proof-of-onward-travel-mexico",
      "/blog/proof-of-onward-travel-peru",
      "/blog/dummy-ticket-visa-application",
    ],
  },
  "/blog/proof-of-onward-travel-japan": {
    keyword: "proof of onward travel Japan",
    title: "Proof of Onward Travel for Japan (2026)",
    meta: "Most visitors enter Japan visa-free, but airlines and immigration can still ask for a return or onward booking. Here's how to be ready.",
    h1: "Proof of Onward Travel for Japan: What You Actually Need in 2026",
    internalLinks: [
      "/blog/proof-of-onward-travel-thailand",
      "/blog/proof-of-onward-travel-vietnam",
      "/blog/dummy-ticket-visa-application",
    ],
  },
  "/blog/proof-of-onward-travel-peru": {
    keyword: "proof of onward travel Peru",
    title: "Proof of Onward Travel for Peru (2026)",
    meta: "Peru and the airlines can ask for proof of onward travel. Here's what's required, where you'll be asked, and how to show it without buying a ticket.",
    h1: "Proof of Onward Travel for Peru: What You Actually Need in 2026",
    internalLinks: [
      "/blog/proof-of-onward-travel-colombia",
      "/blog/proof-of-onward-travel-costa-rica",
      "/blog/dummy-ticket-visa-application",
    ],
  },
  "/blog/onward-ticket-turkey": {
    keyword: "onward ticket Turkey",
    title: "Onward Ticket for Turkey: What Airlines Check (2026)",
    meta: "Turkey's e-visa is easy, but airlines can still ask for an onward ticket at check-in. Here's what counts and how to show it without buying a flight.",
    h1: "Onward Ticket for Turkey: What Airlines Actually Check in 2026",
    internalLinks: [
      "/blog/flight-reservation-schengen-visa",
      "/blog/dummy-ticket-visa-application",
      "/blog/proof-of-onward-travel-thailand",
    ],
  },
};

export function seoTargetFor(route) {
  return SEO_TARGETS[route] || null;
}

// The set of routes that exist right now. Guide slugs come from disk, so a
// newly published guide is live the moment its markdown lands.
export function liveRoutes(articleSlugs) {
  const set = new Set(STATIC_ROUTES);
  for (const slug of articleSlugs || []) set.add(`/blog/${slug}`);
  return set;
}

// Filters a page's mapped internal links down to the ones that resolve today.
// This is the rule that keeps 404s out of the internal link graph while letting
// the map stay forward-looking.
export function liveLinks(route, articleSlugs, { exclude } = {}) {
  const target = SEO_TARGETS[route];
  if (!target || !target.internalLinks) return [];
  const live = liveRoutes(articleSlugs);
  return target.internalLinks.filter((l) => l !== exclude && l !== route && live.has(l));
}

// Human label for a link, used when the target has no article record (the
// static pages) so anchor text stays meaningful rather than showing a URL.
const STATIC_LABELS = {
  "/": "Get a reservation",
  "/blog": "All travel and visa guides",
  "/faq": "Help and FAQ",
  "/sample-reservation": "See a sample reservation",
  "/privacy": "Privacy Policy",
};

export function linkLabel(route, articles) {
  const found = (articles || []).find((a) => `/blog/${a.slug}` === route);
  if (found) return found.heading || found.title;
  if (STATIC_LABELS[route]) return STATIC_LABELS[route];
  const target = SEO_TARGETS[route];
  return target ? target.h1 : route;
}
