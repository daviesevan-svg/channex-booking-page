// Availability for a slice of the date picker's calendar.
//
// The page loads the first few months (see calendar-window.ts); this serves the
// rest as the guest pages forward, so a property with two years of inventory
// doesn't send thirteen months of it to everyone who opens the search.
//
// Public on purpose — it says which dates are open, which is what the picker on
// the page already shows. It carries no prices, no rooms and no guest data, and
// the span cap below is what stops it being used to walk a property's whole
// history in one request.
import type { Route } from "./+types/calendar";
import { getCalendarAvailability } from "~/lib/catalog.server";
import { CALENDAR_HORIZON_MONTHS } from "~/lib/calendar-window";
import { resolveRequestProperty } from "~/lib/property-scope.server";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Days the picker can ever ask for at once: the whole horizon, so a single
 *  request can always be satisfied, and nothing beyond it. */
const MAX_SPAN_DAYS = Math.ceil(CALENDAR_HORIZON_MONTHS * 31);

export async function loader({ params, request }: Route.LoaderArgs) {
  const pid = await resolveRequestProperty(params.channelId, request);
  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const roomId = url.searchParams.get("roomId") || undefined;

  if (!ISO.test(from) || !ISO.test(to)) {
    throw new Response("`from` and `to` are required (YYYY-MM-DD).", { status: 400 });
  }
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
  if (!(span >= 0) || span > MAX_SPAN_DAYS) {
    throw new Response(`\`to\` must be on/after \`from\` and within ${MAX_SPAN_DAYS} days.`, { status: 400 });
  }

  const closedDates = await getCalendarAvailability(pid, from, to, { roomId });
  return Response.json(
    { from, to, closedDates },
    // Availability changes with every booking and every channel push, so this
    // is deliberately not cached at the edge; it is one small D1 read.
    { headers: { "cache-control": "no-store" } },
  );
}
