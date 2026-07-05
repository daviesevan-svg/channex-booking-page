// Google Hotels landing-page redirect (Points of Sale target). Google sends
// every hotel click here with the hotel id + stay params; we route it:
//   • one of OUR properties  → straight into our booking flow
//   • anything else (Channex) → 302 to Channex's booking_link, params intact
// Registered at /go/booking. Point the Google POS <URL> at this path (same
// params as Channex's booking_link, so the template is theirs with our host).
//
// Google's POS can't route by hotel (Match is by user context, not hotel), so a
// single landing URL must fan out server-side — which is what this does.
import { addDays, format, parseISO } from "date-fns";

import type { Route } from "./+types/go.booking";
import { getProperty } from "~/lib/properties.server";

// Channex's Google Hotel ARI landing endpoint — where we forward hotels that
// aren't ours, unchanged.
const CHANNEX_BOOKING_LINK = "https://app.channex.io/api/v1/meta/googlehotelari/booking_link";

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams;
  const channelId = (q.get("channel_id") || "").trim();

  // Not one of ours → hand straight back to Channex with the exact query string,
  // so their hotels behave exactly as they do today.
  if (!channelId || !(await getProperty(channelId))) {
    return Response.redirect(`${CHANNEX_BOOKING_LINK}?${q.toString()}`, 302);
  }

  // Ours → send the guest into our booking flow with the stay prefilled.
  const checkin = (q.get("checkin_date") || "").trim();
  const checkoutParam = (q.get("checkout_date") || "").trim();
  const length = parseInt(q.get("length") || "", 10);
  const checkout =
    isDate(checkoutParam)
      ? checkoutParam
      : isDate(checkin) && Number.isFinite(length) && length > 0
        ? format(addDays(parseISO(checkin), length), "yyyy-MM-dd")
        : "";
  const adults = Math.max(1, parseInt(q.get("adults") || "2", 10) || 2);

  const base = `${url.origin}/${channelId}`;
  // Without usable dates, land on the property home (its date picker) rather
  // than the results page (which would just bounce back for missing dates).
  if (!isDate(checkin) || !isDate(checkout)) {
    return Response.redirect(base, 302);
  }
  const dest = new URLSearchParams({ checkin, checkout, adults: String(adults) });
  return Response.redirect(`${base}/rooms?${dest.toString()}`, 302);
}
