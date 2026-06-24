import { format, parseISO } from "date-fns";
import { Link } from "react-router";

import type { Route } from "./+types/bookings";
import { BookingStatusBadge } from "~/components/booking-status";
import { requireAdmin } from "~/lib/auth.server";
import { getBookings } from "~/lib/bookings.server";
import { getConfig } from "~/lib/config.server";
import { formatMoney } from "~/lib/money";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = getConfig().defaultPropertyId;
  if (!propertyId) return { configured: false as const };
  return { configured: true as const, bookings: await getBookings(propertyId) };
}

export function meta() {
  return [{ title: "Admin · Bookings" }];
}

export default function AdminBookings({ loaderData }: Route.ComponentProps) {
  if (!loaderData.configured) {
    return (
      <div className="rounded-[14px] border border-line bg-surface p-6">
        <h1 className="mb-2 font-serif text-[22px] font-semibold">Bookings</h1>
        <p className="text-[15px] text-secondary">
          Set <code className="rounded bg-chip px-1.5 py-0.5">DEFAULT_PROPERTY_ID</code> to record
          bookings.
        </p>
      </div>
    );
  }

  const { bookings } = loaderData;

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">Bookings</h1>
      <p className="mb-6 text-[14px] text-muted">
        {bookings.length} booking{bookings.length === 1 ? "" : "s"} recorded. Click one to see the
        full details.
      </p>

      {bookings.length === 0 ? (
        <div className="rounded-[14px] border border-line bg-surface p-6 text-[14px] text-secondary">
          No bookings yet. Completed checkouts will appear here.
        </div>
      ) : (
        <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
          {bookings.map((b, i) => (
            <Link
              key={b.id}
              to={`/admin/bookings/${b.id}`}
              className={`flex items-center justify-between gap-4 px-5 py-4 hover:bg-field-hover ${
                i > 0 ? "border-t border-divider" : ""
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <span className="truncate font-semibold">
                    {b.guest.firstName} {b.guest.lastName}
                  </span>
                  <BookingStatusBadge status={b.status} />
                </div>
                <div className="mt-0.5 text-[12.5px] text-muted-2">
                  {b.reference} · {format(parseISO(b.checkin), "d MMM")} —{" "}
                  {format(parseISO(b.checkout), "d MMM yyyy")} ·{" "}
                  {b.rooms.length} room{b.rooms.length === 1 ? "" : "s"}
                </div>
                <div className="mt-0.5 text-[11px] text-faint">
                  {format(parseISO(b.createdAt), "d MMM yyyy, HH:mm")}
                </div>
              </div>
              <div className="flex flex-none items-center gap-4">
                <span className="font-serif text-[18px] font-semibold">
                  {formatMoney(b.total, b.currency)}
                </span>
                <span className="text-[13px] font-semibold text-accent">View →</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
