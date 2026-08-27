import type { Route } from "./+types/api.v1.manage.bookings";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { getBookings } from "~/lib/bookings.server";
import { serializeManageBooking } from "~/lib/manage-serialize";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
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
    if (v && !DATE.test(v)) return apiError(422, "validation_error", `\`${p}\` must be YYYY-MM-DD.`);
  }
  const status = q.get("status");
  if (status && !["confirmed", "simulated", "failed"].includes(status)) {
    return apiError(422, "validation_error", "`status` must be confirmed, simulated or failed.");
  }
  const lifecycle = q.get("lifecycle");
  if (lifecycle && !["active", "cancelled"].includes(lifecycle)) {
    return apiError(422, "validation_error", "`lifecycle` must be active or cancelled.");
  }
  const limit = Math.min(Math.max(Number(q.get("limit")) || 50, 1), MAX_LIMIT);
  const offset = Math.max(Number(q.get("offset")) || 0, 0);

  const all = await getBookings(auth.pid);
  const filtered = all
    .filter((b) => !status || b.status === status)
    .filter((b) => !lifecycle || (b.lifecycle ?? "active") === lifecycle)
    .filter((b) => !q.get("checkin_from") || b.checkin >= q.get("checkin_from")!)
    .filter((b) => !q.get("checkin_to") || b.checkin <= q.get("checkin_to")!)
    .filter((b) => !q.get("created_from") || b.createdAt.slice(0, 10) >= q.get("created_from")!)
    .filter((b) => !q.get("created_to") || b.createdAt.slice(0, 10) <= q.get("created_to")!)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return Response.json({
    data: filtered.slice(offset, offset + limit).map(serializeManageBooking),
    total: filtered.length,
    limit,
    offset,
  });
}
