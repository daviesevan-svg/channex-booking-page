import { fmtDate } from "~/lib/dates";
import { Link, redirect } from "react-router";

import type { Route } from "./+types/bookings";
import { adminMeta } from "~/lib/admin-meta";
import { BookingStatusBadge } from "~/components/booking-status";
import { requireAdmin } from "~/lib/auth.server";
import { currentPropertyId } from "~/lib/properties.server";
import { getBookingsPage } from "~/lib/bookings.server";
import { formatMoney } from "~/lib/money";
import { useAdminDateLocale, useAdminT } from "~/lib/admin-i18n";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { configured: false as const };
  const rawPage = new URL(request.url).searchParams.get("page") ?? "1";
  const page = Number(rawPage);
  const limit = 50;
  if (!/^\d+$/.test(rawPage) || !Number.isSafeInteger(page) || page < 1 ||
      !Number.isSafeInteger((page - 1) * limit)) {
    throw new Response("Page must be a positive safe integer.", { status: 400 });
  }
  const { bookings, total } = await getBookingsPage(propertyId, { limit, offset: (page - 1) * limit });
  const pageUrl = (n: number) => {
    const query = new URL(request.url).searchParams;
    query.set("page", String(n));
    return `?${query}`;
  };
  const lastPage = Math.max(1, Math.ceil(total / limit));
  if (page > lastPage) throw redirect(pageUrl(lastPage));
  return {
    configured: true as const, bookings, total, page,
    previousPage: page > 1 ? pageUrl(page - 1) : null,
    nextPage: page * limit < total ? pageUrl(page + 1) : null,
  };
}

export function meta({ matches }: Route.MetaArgs) {
  return adminMeta(matches, { key: "navBookings" });
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

  const { bookings, total, page, previousPage, nextPage } = loaderData;

  return (
    <div>
      <h1 className="mb-1 font-serif text-[26px] font-semibold">{t("bkTitle")}</h1>
      <p className="mb-6 text-[14px] text-muted">
        {total === 1
          ? t("bkCountOne", { n: total })
          : t("bkCountMany", { n: total })}
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
                <div className="mt-0.5 text-[12px] text-muted-2">
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
      {(previousPage || nextPage) && (
        <nav aria-label={t("bkTitle")} className="mt-4 flex items-center justify-between gap-4 text-[14px]">
          <div>{previousPage && <Link to={previousPage} className="font-semibold text-accent">← {t("bkPreviousPage")}</Link>}</div>
          <span className="text-muted">{t("bkPage", { n: page })}</span>
          <div>{nextPage && <Link to={nextPage} className="font-semibold text-accent">{t("bkNextPage")} →</Link>}</div>
        </nav>
      )}
    </div>
  );
}
