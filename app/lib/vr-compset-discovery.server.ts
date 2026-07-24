// Vacation-rental comp-set discovery: find comparable short-term rentals from
// Airbnb search results (via Scrapfly) and hand them back as *suggestions* the
// host reviews, confirms and reorders — nothing is added automatically. The
// VR analogue of revman-compset-discovery (Booking.com); the manual comp set +
// ranking live in vr-compset.server / vr-compset.
//
// Airbnb renders search results client-side, so unlike Booking we DO need a JS
// render. The listing data is emitted into an embedded state blob
// (`<script id="data-deferred-state-0">…JSON…</script>`); we parse that rather
// than scraping DOM cards, because the JSON is far more stable than Airbnb's
// churning CSS-hash class names. Verified against a live Carmarthen pull
// (20/20 listings parsed).
import { classifyPlace, type PlaceClass } from "./vr-compset";
import { scrapeUrl, isScrapflyConfigured } from "./scrapfly.server";

export interface CandidateVrUnit {
  name: string;
  /** Airbnb room id (digits), stable key for the later per-night price feed. */
  airbnbRef: string;
  placeType?: string;
  placeClass?: PlaceClass;
  reviewScore?: number;
  reviewCount?: number;
  lat?: number;
  lng?: number;
}

export interface DiscoverVrResult {
  ok: boolean;
  candidates: CandidateVrUnit[];
  /** The host's own listing as found in the results (matched by Airbnb ref, or
   *  failing that by name), pulled out so the self row scores from the same
   *  source as its comps. Null when not matched. */
  self: CandidateVrUnit | null;
  cost: number | null;
  searchUrl: string;
  error?: string;
}

/** Airbnb geo-redirects www.airbnb.com → a country domain for non-US proxies
 *  (a POST handoff that returns an empty page to a scraper). Hitting the
 *  country domain directly for the proxy country skips that. Extend as needed. */
const TLD_BY_COUNTRY: Record<string, string> = { gb: "co.uk", us: "com", ie: "ie", au: "com.au", ca: "ca" };

/** Builds an Airbnb search URL for a free-text area (town/city/region). Airbnb
 *  paths use "--" between locality parts and "-" for spaces within a part;
 *  e.g. "Carmarthen, Wales" → /s/Carmarthen--Wales/homes. */
export function buildAirbnbSearchUrl(
  area: string,
  opts: { adults?: number; checkin?: string; checkout?: string; country?: string } = {},
): string {
  const tld = TLD_BY_COUNTRY[(opts.country ?? "gb").toLowerCase()] ?? "com";
  const slug = area
    .trim()
    .split(",")
    .map((part) => encodeURIComponent(part.trim().replace(/\s+/g, "-")))
    .filter(Boolean)
    .join("--");
  const p = new URLSearchParams({ adults: String(opts.adults ?? 2) });
  if (opts.checkin && opts.checkout) {
    p.set("check_in", opts.checkin);
    p.set("check_out", opts.checkout);
  }
  return `https://www.airbnb.${tld}/s/${slug}/homes?${p.toString()}`;
}

/** Airbnb room-page URL for a ref (for the host to open / the later price feed). */
export function buildAirbnbListingUrl(ref: string, country = "gb"): string {
  const tld = TLD_BY_COUNTRY[country.toLowerCase()] ?? "com";
  return `https://www.airbnb.${tld}/rooms/${encodeURIComponent(ref)}`;
}

/** Decode Airbnb's base64 node id ("DemandStayListing:12345" → "12345"). Falls
 *  back to the raw value if it isn't the expected base64 shape. */
function decodeRoomId(nodeId: string): string {
  try {
    const decoded = atob(nodeId);
    const parts = decoded.split(":");
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(last)) return last;
  } catch {
    /* not base64 — fall through */
  }
  return nodeId;
}

/** "5.0 (25)" → { score: 5, count: 25 }; null when it doesn't match. */
function parseRating(localized: string | undefined): { score: number; count: number } | null {
  if (!localized) return null;
  const m = localized.match(/([\d.]+)\s*\((\d[\d,]*)\)/);
  if (!m) return null;
  const score = Number(m[1]);
  const count = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(score) || !Number.isFinite(count)) return null;
  return { score, count };
}

/** Parse Airbnb search-results HTML into candidate units, from the embedded
 *  `data-deferred-state-0` JSON. Deduped by room id, in page order. */
export function parseAirbnbListings(html: string): CandidateVrUnit[] {
  const m = html.match(/<script id="data-deferred-state-0"[^>]*>(.*?)<\/script>/s);
  if (!m) return [];
  let state: unknown;
  try {
    state = JSON.parse(m[1]);
  } catch {
    return [];
  }

  // Walk the tree collecting every node that carries a demandStayListing — that
  // marks one search-result card. (The tree nests results under several keys
  // that change over time, so a structural walk is more robust than a path.)
  const nodes: Record<string, unknown>[] = [];
  const seenRefs = new Set<string>();
  const stack: unknown[] = [state];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (const v of cur) if (v && typeof v === "object") stack.push(v);
    } else if (cur && typeof cur === "object") {
      const obj = cur as Record<string, unknown>;
      if (obj.demandStayListing && typeof obj.demandStayListing === "object") nodes.push(obj);
      for (const v of Object.values(obj)) if (v && typeof v === "object") stack.push(v);
    }
  }

  const out: CandidateVrUnit[] = [];
  for (const node of nodes) {
    const dsl = node.demandStayListing as Record<string, unknown>;
    const nodeId = typeof dsl.id === "string" ? dsl.id : "";
    if (!nodeId) continue;
    const ref = decodeRoomId(nodeId);
    if (seenRefs.has(ref)) continue;
    seenRefs.add(ref);

    const title = typeof node.title === "string" ? node.title : undefined;
    const subtitle = typeof node.subtitle === "string" ? node.subtitle : undefined;
    const { placeType, placeClass } = classifyPlace(title);
    const rating = parseRating(typeof node.avgRatingLocalized === "string" ? node.avgRatingLocalized : undefined);

    // Prefer the human name (subtitle is the listing's own name) then the
    // generic "Cottage in X" title; fall back so a unit always has a label.
    // Collapse the odd embedded newline Airbnb leaves in some titles.
    const name = (subtitle || title || `Listing ${ref}`).replace(/\s+/g, " ").trim();

    const coord = ((dsl.location as Record<string, unknown>)?.coordinate ?? {}) as Record<string, unknown>;
    const lat = typeof coord.latitude === "number" ? coord.latitude : undefined;
    const lng = typeof coord.longitude === "number" ? coord.longitude : undefined;

    out.push({
      name,
      airbnbRef: ref,
      placeType,
      placeClass,
      reviewScore: rating?.score,
      reviewCount: rating?.count,
      lat,
      lng,
    });
  }
  return out;
}

/** Discover comparable rentals for an area (or a full Airbnb search URL). JS
 *  render + residential proxy are both required; datacenter/no-render return an
 *  empty shell. Never throws — degrades to `ok:false` + error. */
export async function discoverVrComps(
  areaOrUrl: string,
  opts: {
    adults?: number;
    checkin?: string;
    checkout?: string;
    country?: string;
    /** Host's own Airbnb ref and/or name, pulled out of the candidates and
     *  returned as `self` so the self row scores from the same source. */
    selfRef?: string;
    selfName?: string;
  } = {},
): Promise<DiscoverVrResult> {
  const input = areaOrUrl.trim();
  const searchUrl = /^https?:\/\//i.test(input) ? input : buildAirbnbSearchUrl(input, opts);

  if (!isScrapflyConfigured()) {
    return { ok: false, candidates: [], self: null, cost: null, searchUrl, error: "Scrapfly API key not configured." };
  }
  if (!input) {
    return { ok: false, candidates: [], self: null, cost: null, searchUrl, error: "Enter a town, city or region to search." };
  }

  const res = await scrapeUrl(searchUrl, {
    asp: true,
    renderJs: true, // Airbnb results are client-rendered; no render = empty shell
    proxyPool: "public_residential_pool",
    country: opts.country ?? "gb",
    format: "raw",
    timeoutMs: 90_000,
  });
  if (!res.ok) {
    return { ok: false, candidates: [], self: null, cost: res.cost, searchUrl, error: res.error ?? "Scrape failed." };
  }

  let candidates = parseAirbnbListings(res.content);
  let self: CandidateVrUnit | null = null;
  const selfRef = opts.selfRef?.trim();
  const sn = opts.selfName?.trim().toLowerCase();
  const isSelf = (c: CandidateVrUnit): boolean => {
    if (selfRef && c.airbnbRef === selfRef) return true;
    if (sn) {
      const n = c.name.toLowerCase();
      return n === sn; // exact only — VR titles are generic, so no substring match
    }
    return false;
  };
  if (selfRef || sn) {
    self = candidates.find(isSelf) ?? null;
    candidates = candidates.filter((c) => !isSelf(c));
  }
  return { ok: true, candidates, self, cost: res.cost, searchUrl };
}
