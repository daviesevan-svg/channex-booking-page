import { Link, redirect } from "react-router";

import type { Route } from "./+types/booking";
import { BookingStatusBadge } from "~/components/booking-status";
import { cancellationMessage } from "~/lib/cancellation";
import { fmtDate } from "~/lib/dates";
import { makeTranslator } from "~/lib/i18n";
import { requireAdmin } from "~/lib/auth.server";
import { getBooking } from "~/lib/bookings.server";
import { getConfig } from "~/lib/config.server";
import { formatMoney } from "~/lib/money";

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = getConfig().defaultPropertyId;
  if (!propertyId) throw redirect("/admin/bookings");
  const booking = await getBooking(propertyId, params.id);
  if (!booking) throw redirect("/admin/bookings");
  return { booking };
}

export function meta() {
  return [{ title: "Admin · Booking" }];
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5">
      <span className="text-[13px] text-muted-2">{label}</span>
      <span className="text-right text-[14px] font-medium text-ink">{value}</span>
    </div>
  );
}

export default function AdminBooking({ loaderData }: Route.ComponentProps) {
  const { booking: b } = loaderData;
  const en = makeTranslator("en"); // admin UI is English
  const msg = cancellationMessage(b.cancellation, Date.now());
  const cancellationText = msg
    ? en.t(msg.key, "iso" in msg ? { date: fmtDate(msg.iso, "EEE d MMM yyyy") } : undefined)
    : "";

  return (
    <div>
      <Link
        to="/admin/bookings"
        className="mb-4 inline-block text-[13px] font-semibold text-muted hover:text-accent"
      >
        ← All bookings
      </Link>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-[26px] font-semibold">
          {b.guest.firstName} {b.guest.lastName}
        </h1>
        <div className="flex items-center gap-2.5">
          {(b.lifecycle ?? "active") === "cancelled" && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#fbe9e7] px-2.5 py-1 text-[12px] font-semibold text-[#c0392b]">
              ✕ Cancelled
            </span>
          )}
          <BookingStatusBadge status={b.status} />
        </div>
      </div>

      {(b.lifecycle ?? "active") === "cancelled" && b.cancelledAt && (
        <div className="mb-5 rounded-[12px] border border-[#f3d0ca] bg-[#fbe9e7] px-4 py-3 text-[13.5px] text-[#c0392b]">
          Cancelled by the guest on {fmtDate(b.cancelledAt, "d MMM yyyy, HH:mm")}.
        </div>
      )}

      {b.status === "failed" && b.error && (
        <div className="mb-5 rounded-[12px] border border-red-200 bg-red-50 px-4 py-3 text-[13.5px] text-red-700">
          <span className="font-semibold">Channex error:</span> {b.error}
        </div>
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        <section className="rounded-[14px] border border-line bg-surface p-5">
          <h2 className="mb-3 font-serif text-[18px] font-semibold">Booking</h2>
          <Row label="Reference" value={<span className="font-mono text-[13px]">{b.reference}</span>} />
          {b.channexId && (
            <Row
              label="Channex ID"
              value={<span className="font-mono text-[13px]">{b.channexId}</span>}
            />
          )}
          <Row label="Check-in" value={fmtDate(b.checkin, "EEE d MMM yyyy")} />
          <Row label="Check-out" value={fmtDate(b.checkout, "EEE d MMM yyyy")} />
          <Row label="Nights" value={String(b.nights)} />
          <Row label="Booked" value={fmtDate(b.createdAt, "d MMM yyyy, HH:mm")} />
        </section>

        <section className="rounded-[14px] border border-line bg-surface p-5">
          <h2 className="mb-3 font-serif text-[18px] font-semibold">Guest</h2>
          <Row label="Name" value={`${b.guest.firstName} ${b.guest.lastName}`} />
          <Row
            label="Email"
            value={
              <a href={`mailto:${b.guest.email}`} className="text-accent hover:underline">
                {b.guest.email}
              </a>
            }
          />
          <Row label="Phone" value={b.guest.phone} />
          {b.guest.arrival && <Row label="Arrival time" value={b.guest.arrival} />}
          {b.guest.requests && <Row label="Requests" value={b.guest.requests} />}
        </section>
      </div>

      <section className="mt-5 rounded-[14px] border border-line bg-surface p-5">
        <h2 className="mb-3 font-serif text-[18px] font-semibold">Rooms</h2>
        <div className="flex flex-col divide-y divide-divider">
          {b.rooms.map((r, i) => (
            <div key={i} className="flex items-start justify-between gap-4 py-3 first:pt-0">
              <div className="min-w-0">
                <div className="font-semibold">{r.roomTitle}</div>
                <div className="text-[13px] text-muted-2">
                  {r.rateTitle} · {r.adults} adult{r.adults === 1 ? "" : "s"}
                  {r.children ? `, ${r.children} child${r.children === 1 ? "" : "ren"}` : ""}
                </div>
              </div>
              <span className="whitespace-nowrap font-semibold">
                {formatMoney(r.total, b.currency)}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-baseline justify-between border-t border-divider pt-4">
          <span className="text-[15px] font-semibold">Total</span>
          <span className="font-serif text-[24px] font-semibold">
            {formatMoney(b.total, b.currency)}
          </span>
        </div>
      </section>

      {cancellationText && (
        <section className="mt-5 rounded-[14px] border border-line bg-surface p-5">
          <h2 className="mb-2 font-serif text-[18px] font-semibold">Cancellation policy</h2>
          <p className="text-[14px] text-secondary">{cancellationText}</p>
        </section>
      )}

      <section className="mt-5 rounded-[14px] border border-line bg-surface p-5">
        <h2 className="mb-3 font-serif text-[18px] font-semibold">Payment</h2>
        <p className="text-[14px] text-muted-2">No payment information captured yet.</p>
      </section>
    </div>
  );
}
