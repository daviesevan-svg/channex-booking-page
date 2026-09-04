// The shared preamble of every dated guest page (results, room detail, extras,
// and checkout's loader AND action): parse the stay from the URL, resolve the
// property, bounce anything unbookable, and pin the currency to the property's.
//
// One implementation on purpose. The five copies had already drifted once in a
// way that mattered: checkout's carried `?currency=` off the URL into the stay,
// immediately overwritten by both call sites with a comment explaining why — a
// sixth caller that forgot the overwrite would have charged in a spoofable
// currency. Here the URL currency is never read at all: no conversion exists
// anywhere, so a spoofed ?currency= would just re-denominate the same number
// (pay ¥500 for a £500 room).

import { differenceInCalendarDays, parseISO } from "date-fns";
import { redirect } from "react-router";

import { basePath, homePath } from "./base";
import { isStayBookable, isTooLastMinute } from "./dates";
import { stripInternalParams } from "./internal-params";
import { readOccupancy, type Occupancy } from "./occupancy";
import { getBookingCutoff, getSettings } from "./overrides.server";
import { resolveRequestProperty } from "./property-scope.server";

export interface DatedStay {
  /** The resolved property id (a UUID) — every data lookup uses this. */
  pid: string;
  /** Link prefixes keyed by the ORIGINAL URL segment, so slugs stay in the URL. */
  base: string;
  home: string;
  /**
   * The request URL, minus React Router's internal params.
   *
   * Every dated page builds redirects and links by copying this query string
   * (`?${url.searchParams}`), and during a client-side navigation the request is
   * for `<path>.data?…&_routes=…`. Copying that verbatim put `_routes` in the
   * guest's address bar for the rest of the funnel — see internal-params.ts for
   * what it then breaks. Stripped once here rather than at each of the seven
   * call sites, so a new one can't reintroduce it.
   */
  url: URL;
  checkin: string;
  checkout: string;
  occ: Occupancy;
  /** The property's configured currency — NEVER the URL's. */
  currency: string;
  nights: number;
  settings: Awaited<ReturnType<typeof getSettings>>;
}

/**
 * The stay a dated guest page is for, or a redirect out — home when the dates
 * are missing, unbookable, or inside the property's last-minute cutoff.
 * (An unknown property still 404s via resolveRequestProperty, before any
 * date check redirects.)
 */
export async function requireDatedStay(
  channelId: string | undefined,
  request: Request,
): Promise<DatedStay> {
  const base = basePath(channelId);
  const home = homePath(channelId);
  const url = new URL(request.url);
  stripInternalParams(url.searchParams);
  const checkin = url.searchParams.get("checkin");
  const checkout = url.searchParams.get("checkout");
  const occ = readOccupancy(url.searchParams);
  // :channelId may be a slug — resolve to the real id for data lookups;
  // redirects and links keep the slug via base/home.
  const pid = await resolveRequestProperty(channelId, request);

  if (!checkin || !checkout || !isStayBookable(checkin, checkout)) throw redirect(home);
  if (isTooLastMinute(checkin, await getBookingCutoff(pid))) throw redirect(home);

  const settings = await getSettings(pid);
  return {
    pid,
    base,
    home,
    url,
    checkin,
    checkout,
    occ,
    currency: settings.currency || "GBP",
    nights: Math.max(1, differenceInCalendarDays(parseISO(checkout), parseISO(checkin))),
    settings,
  };
}
