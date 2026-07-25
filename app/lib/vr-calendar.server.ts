// Airbnb availability-calendar client. This is the cheap, dense path for
// availability: ONE call returns up to 12 months of per-day availability for a
// listing (verified: 365 days, ~25 Scrapfly credits, NO JS render), versus one
// dated search per date. Availability is the signal that matters most for a
// rental (it's what booking pace is inferred from), so it gets the efficient
// per-listing feed; prices — which move slowly for rentals — stay on the dated
// search at a coarse cadence (see vr-comp-capture).
//
// The endpoint is a GraphQL *persisted query*: the operation's sha256 hash is
// part of the URL and Airbnb rotates it on deploys. A stale hash fails cleanly
// and identifiably (HTTP 400 `persisted_query_not_found`), so we:
//   1. keep the working hash in KV (seeded with a verified one),
//   2. surface `hashStale` so callers fall back to the dated-search path
//      instead of silently capturing nothing,
//   3. allow a manual override (superadmin) and a best-effort auto-discovery.
// The API key below is Airbnb's public web client key, embedded in every page.
import { getConfigKV } from "./config.server";
import { scrapeUrl, isScrapflyConfigured } from "./scrapfly.server";

/** Airbnb's public web API key (present in the page source of every listing). */
const AIRBNB_API_KEY = "d306zoyjsyarp7ifhu67rjxn52tv0t20";

/** Verified-working persisted-query hash for PdpAvailabilityCalendar. Only a
 *  default: the live value is whatever KV holds (see getCalendarHash). */
const DEFAULT_CALENDAR_HASH = "8f08e03c7bd16fcad3c92a3592c19a8b559a0d0855a84028d1163d4733ed9ade";

const HASH_KEY = "vrcal:hash";

const TLD_BY_COUNTRY: Record<string, string> = { gb: "co.uk", us: "com", ie: "ie", au: "com.au", ca: "ca" };

export async function getCalendarHash(): Promise<string> {
  const kv = getConfigKV();
  if (!kv) return DEFAULT_CALENDAR_HASH;
  return (await kv.get(HASH_KEY)) || DEFAULT_CALENDAR_HASH;
}

/** Store a hash (manual override, or a discovered one). Empty string resets. */
export async function setCalendarHash(hash: string): Promise<void> {
  const kv = getConfigKV();
  if (!kv) return;
  const clean = hash.trim().toLowerCase();
  if (!clean) await kv.delete(HASH_KEY);
  else if (/^[a-f0-9]{64}$/.test(clean)) await kv.put(HASH_KEY, clean);
  else throw new Error("A persisted-query hash must be 64 hex characters.");
}

export interface CalendarDay {
  date: string;
  /** Airbnb's `available` for the night. */
  available: boolean;
  /** `bookable` — available AND satisfying the listing's booking rules. */
  bookable: boolean;
  /** Minimum stay required for a check-in on this date (0 when unknown). This
   *  is why the calendar beats the dated search for availability: a listing
   *  missing from a 1-night search may just require a longer stay, which we can
   *  now tell apart from actually being booked. */
  minNights: number;
}

export interface CalendarResult {
  ok: boolean;
  days: CalendarDay[];
  cost: number | null;
  /** True when Airbnb rejected the persisted-query hash — the caller should
   *  fall back to the dated-search path and prompt for a refreshed hash. */
  hashStale: boolean;
  error?: string;
}

/** Fetches `months` months of availability for one listing, starting at the
 *  month containing `fromISO`. Airbnb caps the response around 12 months. */
export async function fetchListingCalendar(
  listingRef: string,
  opts: { fromISO: string; months?: number; country?: string; currency?: string } = { fromISO: "" },
): Promise<CalendarResult> {
  if (!isScrapflyConfigured()) {
    return { ok: false, days: [], cost: null, hashStale: false, error: "Scrapfly API key not configured." };
  }
  const ref = listingRef.trim();
  if (!/^\d+$/.test(ref)) {
    return { ok: false, days: [], cost: null, hashStale: false, error: "A numeric Airbnb listing id is required." };
  }

  const start = new Date(`${opts.fromISO || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) {
    return { ok: false, days: [], cost: null, hashStale: false, error: "Invalid start date." };
  }
  const months = Math.min(12, Math.max(1, Math.round(opts.months ?? 12)));
  const hash = await getCalendarHash();
  const tld = TLD_BY_COUNTRY[(opts.country ?? "gb").toLowerCase()] ?? "com";

  const variables = JSON.stringify({
    request: {
      count: months,
      listingId: ref,
      month: start.getUTCMonth() + 1,
      year: start.getUTCFullYear(),
    },
  });
  const extensions = JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } });
  const url =
    `https://www.airbnb.${tld}/api/v3/PdpAvailabilityCalendar/${hash}` +
    `?operationName=PdpAvailabilityCalendar&locale=en&currency=${encodeURIComponent(opts.currency ?? "GBP")}` +
    `&variables=${encodeURIComponent(variables)}&extensions=${encodeURIComponent(extensions)}`;

  const res = await scrapeUrl(url, {
    asp: true,
    renderJs: false, // a JSON API — rendering would only cost more
    proxyPool: "public_residential_pool",
    country: opts.country ?? "gb",
    format: "raw",
    timeoutMs: 60_000,
    headers: { "X-Airbnb-Api-Key": AIRBNB_API_KEY },
  });

  // A rotated hash comes back as an upstream 400 with this error_type. Scrapfly
  // reports the body even for non-2xx, so check the payload either way.
  const stale = /persisted_query_not_found|PersistedQueryNotFound/i.test(res.content || "");
  if (stale) {
    return { ok: false, days: [], cost: res.cost, hashStale: true, error: "Airbnb rotated its calendar query hash." };
  }
  if (!res.ok) {
    return { ok: false, days: [], cost: res.cost, hashStale: false, error: res.error ?? "Calendar fetch failed." };
  }

  const days = parseCalendarDays(res.content);
  if (days.length === 0) {
    return { ok: false, days: [], cost: res.cost, hashStale: false, error: "Calendar response had no days." };
  }
  return { ok: true, days, cost: res.cost, hashStale: false };
}

/** Parses the PdpAvailabilityCalendar JSON body into flat days. Tolerant: an
 *  unexpected shape yields [] rather than throwing. */
export function parseCalendarDays(body: string): CalendarDay[] {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }
  const cal = (((json as Record<string, unknown>)?.data as Record<string, unknown>)?.merlin as Record<string, unknown>)
    ?.pdpAvailabilityCalendar as Record<string, unknown> | undefined;
  const months = Array.isArray(cal?.calendarMonths) ? (cal.calendarMonths as Record<string, unknown>[]) : [];
  const out: CalendarDay[] = [];
  for (const month of months) {
    const days = Array.isArray(month?.days) ? (month.days as Record<string, unknown>[]) : [];
    for (const d of days) {
      const date = typeof d.calendarDate === "string" ? d.calendarDate : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      out.push({
        date,
        available: d.available === true,
        bookable: d.bookable === true,
        minNights: typeof d.minNights === "number" ? d.minNights : 0,
      });
    }
  }
  return out;
}

/** Best-effort hash refresh: Airbnb's JS bundles declare operations as
 *  `name:'PdpAvailabilityCalendar',type:'query',operationId:'<64 hex>'`. The
 *  calendar chunk is lazy-loaded so it often isn't among a listing page's
 *  initial bundles — this succeeds when it is, and otherwise reports failure so
 *  an operator can paste a hash manually. Bundles are public CDN files, fetched
 *  directly (no Scrapfly, no tokens). */
export async function discoverCalendarHash(listingRef = "41713487", country = "gb"): Promise<{ ok: boolean; hash?: string; error?: string }> {
  const tld = TLD_BY_COUNTRY[country.toLowerCase()] ?? "com";
  const page = await scrapeUrl(`https://www.airbnb.${tld}/rooms/${encodeURIComponent(listingRef)}`, {
    asp: true,
    proxyPool: "public_residential_pool",
    country,
    format: "raw",
    timeoutMs: 60_000,
  });
  if (!page.ok) return { ok: false, error: page.error ?? "Could not load a listing page." };

  const srcs = [...page.content.matchAll(/src="(https:\/\/a0\.muscache\.com[^"]+?\.js)"/g)].map((m) => m[1]).slice(0, 60);
  const pattern = /name:\s*['"]PdpAvailabilityCalendar['"][^}]{0,200}?operationId:\s*['"]([a-f0-9]{64})['"]/;
  for (let i = 0; i < srcs.length; i += 8) {
    const batch = srcs.slice(i, i + 8);
    const bodies = await Promise.all(
      batch.map((u) =>
        fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } })
          .then((r) => (r.ok ? r.text() : ""))
          .catch(() => ""),
      ),
    );
    for (const body of bodies) {
      const m = body.match(pattern);
      if (m) {
        await setCalendarHash(m[1]);
        return { ok: true, hash: m[1] };
      }
    }
  }
  return { ok: false, error: "Could not find the calendar query hash in Airbnb's current bundles — paste one manually." };
}
