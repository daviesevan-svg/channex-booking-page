import type { Route } from "./+types/api.v1.manage.bookings";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { getBookingsPage, type BookingStatus, type BookingLifecycle } from "~/lib/bookings.server";
import { serializeManageBooking } from "~/lib/manage-serialize";
import { bookingPageParams, isCalendarDate } from "~/lib/api-query";

const MAX_LIMIT = 200;

// GET /v1/manage/bookings — read-only booking list. There are deliberately no
// write verbs on this resource: bookings arrive via Channex and the guest
// checkout, and cancel/refund/modify stay in the admin UI
// (docs/management-api.md §1).
//
// Filters: status (confirmed|simulated|failed), lifecycle (active|cancelled),
// checkin_from/checkin_to (stay window), created_from/created_to, plus
// limit/offset. Sorted newest-created first.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const q = new URL(request.url).searchParams;

  for (const p of ["checkin_from", "checkin_to", "created_from", "created_to"]) {
    const v = q.get(p);
    if (v && !isCalendarDate(v)) return apiError(422, "validation_error", `\`${p}\` must be a real calendar date (YYYY-MM-DD).`);
  }
  const status = q.get("status");
  if (status && !["confirmed", "simulated", "failed"].includes(status)) {
    return apiError(422, "validation_error", "`status` must be confirmed, simulated or failed.");
  }
  const lifecycle = q.get("lifecycle");
  if (lifecycle && !["active", "cancelled"].includes(lifecycle)) {
    return apiError(422, "validation_error", "`lifecycle` must be active or cancelled.");
  }
  const page = bookingPageParams(q, MAX_LIMIT);
  if ("error" in page) return apiError(422, "validation_error", page.error);
  const { limit, offset } = page;
  const { bookings, total } = await getBookingsPage(auth.pid, {
    limit, offset,
    status: (status || undefined) as BookingStatus | undefined,
    lifecycle: (lifecycle || undefined) as BookingLifecycle | undefined,
    checkinFrom: q.get("checkin_from") || undefined,
    checkinTo: q.get("checkin_to") || undefined,
    createdFrom: q.get("created_from") || undefined,
    createdTo: q.get("created_to") || undefined,
    oldestFirstAtSameTime: true,
  });

  return Response.json({
    data: bookings.map(serializeManageBooking),
    total,
    limit,
    offset,
  });
}
