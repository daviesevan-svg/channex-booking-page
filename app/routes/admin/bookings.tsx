import { fmtDate } from "~/lib/dates";
import { Link } from "react-router";

import type { Route } from "./+types/bookings";
import { BookingStatusBadge } from "~/components/booking-status";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getBookings } from "~/lib/bookings.server";
import { formatMoney } from "~/lib/money";
import { useAdminDateLocale, useAdminT } from "~/lib/admin-i18n";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  return { configured: true as const, bookings: await getBookings(propertyId) };
}

export function meta() {
  return [{ title: "Admin · Bookings" }];
}

export default function AdminBookings({ loaderData }: Route.ComponentProps) {
  const t = useAdminT();
  const dl = useAdminDateLocale();

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
      <h1 className="mb-1 font-serif text-[26px] font-semibold">{t("bkTitle")}</h1>
      <p className="mb-6 text-[14px] text-muted">
        {bookings.length === 1
          ? t("bkCountOne", { n: bookings.length })
          : t("bkCountMany", { n: bookings.length })}
      </p>

      {bookings.length === 0 ? (
        <div className="rounded-[14px] border border-line bg-surface p-6 text-[14px] text-secondary">
          {t("bkEmpty")}
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
                  {(b.lifecycle ?? "active") === "cancelled" && (
                    <span className="rounded-full bg-[#fbe9e7] px-2 py-0.5 text-[11px] font-semibold text-[#c0392b]">
                      {t("bkCancelled")}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[12.5px] text-muted-2">
                  {b.reference} · {fmtDate(b.checkin, "d MMM", dl)} —{" "}
                  {fmtDate(b.checkout, "d MMM yyyy", dl)} ·{" "}
                  {b.rooms.length === 1
                    ? t("bkRoomsOne", { n: b.rooms.length })
                    : t("bkRoomsMany", { n: b.rooms.length })}
                </div>
                <div className="mt-0.5 text-[11px] text-faint">
                  {fmtDate(b.createdAt, "d MMM yyyy, HH:mm", dl)}
                </div>
              </div>
              <div className="flex flex-none items-center gap-4">
                <span className="font-serif text-[18px] font-semibold">
                  {formatMoney(b.total, b.currency)}
                </span>
                <span className="text-[13px] font-semibold text-accent">{t("bkView")}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
