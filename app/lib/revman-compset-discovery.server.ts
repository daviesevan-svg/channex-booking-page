// Competitor-set discovery: find nearby similar hotels from Booking.com search
// results (via Scrapfly) and hand them back as *suggestions* for the owner to
// review, confirm and reorder — nothing is added automatically. This is the
// "auto-pull the comp set" setup step; the manual comp set + ranking already
// exist (see revman-compset.server / revman-compset).
//
// We scrape the public Booking.com search-results page for the property's area
// and parse the property cards. Booking renders these server-side, so no JS
// render is needed; the anti-bot posture is Scrapfly's (residential pool + ASP).
import { scrapeUrl, isScrapflyConfigured } from "./scrapfly.server";

export interface CandidateHotel {
  name: string;
  /** Canonical Booking.com hotel path, e.g. "/hotel/gb/ivybushroyal.html" —
   *  stable across locales/query junk; the key for the later price feed. */
  bookingRef: string;
  starClass?: number;
  reviewScore?: number;
  reviewCount?: number;
  /** Human price string as shown on the card (stay total, market currency). A
   *  preview only — not used for ranking; the price feed captures real prices. */
  priceText?: string;
}

export interface DiscoverResult {
  ok: boolean;
  candidates: CandidateHotel[];
  /** The owner's own hotel as found on Booking.com (matched by name), so the
   *  self row can be scored from the same source as its competitors — that's
   *  what gives it a placement in the ranking. Null when not matched. */
  self: CandidateHotel | null;
  /** Scrapfly credit cost of the search (billing visibility). */
  cost: number | null;
  /** The Booking.com search URL actually scraped. */
  searchUrl: string;
  error?: string;
}

const BOOKING_SEARCH = "https://www.booking.com/searchresults.html";

/** Builds a Booking.com search URL for a free-text area (town/city/region). */
export function buildBookingSearchUrl(
  area: string,
  opts: { checkin?: string; checkout?: string; adults?: number; currency?: string } = {},
): string {
  const p = new URLSearchParams({
    ss: area.trim(),
    group_adults: String(opts.adults ?? 2),
    no_rooms: "1",
    group_children: "0",
  });
  if (opts.checkin && opts.checkout) {
    p.set("checkin", opts.checkin);
    p.set("checkout", opts.checkout);
  }
  if (opts.currency) p.set("selected_currency", opts.currency.toUpperCase());
  return `${BOOKING_SEARCH}?${p.toString()}`;
}

const BOOKING = "https://www.booking.com";

/** Builds a Booking.com hotel-page URL for a canonical ref ("/hotel/gb/x.html")
 *  with a 1-night stay + currency, so the page embeds that night's room prices. */
export function buildHotelUrl(
  bookingRef: string,
  opts: { checkin: string; checkout: string; adults?: number; currency?: string },
): string {
  const p = new URLSearchParams({
    checkin: opts.checkin,
    checkout: opts.checkout,
    group_adults: String(opts.adults ?? 2),
    no_rooms: "1",
    group_children: "0",
  });
  if (opts.currency) p.set("selected_currency", opts.currency.toUpperCase());
  const path = bookingRef.startsWith("http") ? bookingRef : `${BOOKING}${bookingRef}`;
  return `${path}?${p.toString()}`;
}

/** Parses the cheapest bookable nightly price from a Booking hotel page. The page
 *  embeds each room block as `"b_price":"£NN"`; for a 1-night search the minimum
 *  of those is the cheapest nightly rate a shopper sees (incl. promos). Null when
 *  the hotel has no availability for the searched night. */
export function parseHotelCheapestPrice(html: string): { minor: number; currency: string } | null {
  let best: { minor: number; currency: string } | null = null;
  for (const m of html.matchAll(/"b_price":"([^"]+)"/g)) {
    const p = parsePriceText(m[1]);
    if (p && (!best || p.minor < best.minor)) best = p;
  }
  return best;
}

/** Parses a Booking price string like "£1,180" / "€92" / "US$140" into minor
 *  units + ISO currency. Returns null when unrecognised. */
export function parsePriceText(text: string | undefined): { minor: number; currency: string } | null {
  if (!text) return null;
  const sym = text.match(/US\$|£|€|\$|R\$|zł|kr|CHF|A\$|C\$/);
  const map: Record<string, string> = {
    "£": "GBP", "€": "EUR", "$": "USD", "US$": "USD", "A$": "AUD", "C$": "CAD", "R$": "BRL",
  };
  const num = text.replace(/[^\d.,]/g, "").replace(/,/g, "");
  const amount = parseFloat(num);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const currency = (sym && map[sym[0]]) || "GBP";
  return { minor: Math.round(amount * 100), currency };
}

/** Normalises a Booking hotel href to its stable path: drops the query string
 *  and any locale segment (".en-gb.html" → ".html"). */
export function canonicalBookingRef(href: string): string {
  try {
    const u = new URL(href, "https://www.booking.com");
    let path = u.pathname; // /hotel/gb/ivybushroyal.en-gb.html
    path = path.replace(/\.[a-z]{2}(-[a-z]{2})?\.html$/i, ".html");
    return path;
  } catch {
    return href;
  }
}

const decode = (s: string): string =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();

/** Parses Booking.com search-results HTML into candidate hotels. Resilient to
 *  markup churn: it splits on property-card boundaries and pulls each field with
 *  its own regex, tolerating missing fields (unrated/self-catering listings). */
export function parseCandidates(html: string): CandidateHotel[] {
  const marker = 'data-testid="property-card"';
  const starts: number[] = [];
  for (let i = html.indexOf(marker); i !== -1; i = html.indexOf(marker, i + 1)) starts.push(i);
  starts.push(html.length);

  const out: CandidateHotel[] = [];
  const seen = new Set<string>();
  for (let k = 0; k < starts.length - 1; k++) {
    const card = html.slice(starts[k], starts[k + 1]);

    const nameM = card.match(/data-testid="title"[^>]*>([^<]+)</);
    const name = nameM ? decode(nameM[1]) : "";
    if (!name) continue;

    const hrefM = card.match(/href="(https:\/\/www\.booking\.com\/hotel\/[^"]+)"/);
    const bookingRef = hrefM ? canonicalBookingRef(decode(hrefM[1])) : "";
    const dedupeKey = bookingRef || name.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    // Review score block renders as "Scored 7.3 7.3 Good 1,635 reviews".
    const scoreArea = card.match(/data-testid="review-score"(.*?)(?:<\/div>\s*){3}/s)?.[1] ?? "";
    const scoreText = scoreArea.replace(/<[^>]+>/g, " ");
    const scoreM = scoreText.match(/Scored\s+([\d.]+)/) ?? scoreText.match(/([\d]+\.[\d])/);
    const countM = scoreText.match(/([\d,]+)\s*reviews?/i);
    const reviewScore = scoreM ? Number(scoreM[1]) : undefined;
    const reviewCount = countM ? Number(countM[1].replace(/,/g, "")) : undefined;

    // Stars: prefer an explicit aria-label ("N out of 5 stars"), else count the
    // star svgs in the rating-stars region (rating-squares = self-catering, skip).
    let starClass: number | undefined;
    const starAria = card.match(/aria-label="(\d)\s*(?:out of 5\s*)?stars?"/i);
    if (starAria) starClass = Number(starAria[1]);
    else {
      const starRegion = card.match(/data-testid="rating-stars"(.*?)<\/div>/s)?.[1];
      if (starRegion) {
        const n = (starRegion.match(/<svg/g) ?? []).length;
        if (n >= 1 && n <= 5) starClass = n;
      }
    }

    const priceM = card.match(/data-testid="price-and-discounted-price"[^>]*>([^<]+)</);
    const priceText = priceM ? decode(priceM[1]) : undefined;

    out.push({
      name,
      bookingRef,
      starClass,
      reviewScore: reviewScore && reviewScore > 0 && reviewScore <= 10 ? reviewScore : undefined,
      reviewCount: reviewCount && reviewCount > 0 ? reviewCount : undefined,
      priceText,
    });
    if (out.length >= 40) break;
  }
  return out;
}

/** Discovers competitor candidates for an area (free text) or a full Booking.com
 *  search URL. Never throws. `excludeName` drops the owner's own hotel from the
 *  results (case-insensitive contains match). */
export async function discoverCompetitors(
  areaOrUrl: string,
  opts: {
    checkin?: string;
    checkout?: string;
    adults?: number;
    country?: string;
    /** The owner's own hotel name: pulled out of the candidates and returned as
     *  `self` so the caller can score the self row from Booking.com. */
    selfName?: string;
  } = {},
): Promise<DiscoverResult> {
  const input = areaOrUrl.trim();
  const searchUrl = /^https?:\/\//i.test(input)
    ? input
    : buildBookingSearchUrl(input, opts);

  if (!isScrapflyConfigured()) {
    return { ok: false, candidates: [], self: null, cost: null, searchUrl, error: "Scrapfly API key not configured." };
  }
  if (!input) {
    return { ok: false, candidates: [], self: null, cost: null, searchUrl, error: "Enter a town, city or region to search." };
  }

  const res = await scrapeUrl(searchUrl, {
    asp: true,
    proxyPool: "public_residential_pool", // datacenter gets a 202 challenge from Booking
    country: opts.country ?? "gb",
    format: "raw",
    timeoutMs: 60_000,
  });
  if (!res.ok) {
    return { ok: false, candidates: [], self: null, cost: res.cost, searchUrl, error: res.error ?? "Scrape failed." };
  }

  let candidates = parseCandidates(res.content);
  let self: CandidateHotel | null = null;
  const sn = opts.selfName?.trim().toLowerCase();
  if (sn) {
    const isSelf = (c: CandidateHotel) => {
      const n = c.name.toLowerCase();
      return n.includes(sn) || sn.includes(n);
    };
    self = candidates.find(isSelf) ?? null;
    candidates = candidates.filter((c) => !isSelf(c));
  }
  return { ok: true, candidates, self, cost: res.cost, searchUrl };
}
