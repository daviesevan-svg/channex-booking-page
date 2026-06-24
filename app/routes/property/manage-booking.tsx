import { format, parseISO } from "date-fns";
import { Link, redirect } from "react-router";

import type { Route } from "./+types/manage-booking";
import { useProperty } from "~/lib/booking-context";
import { getBooking } from "~/lib/bookings.server";
import { getGuestEmail } from "~/lib/guest-auth.server";
import { occLabel, useT } from "~/lib/i18n";
import { formatMoney } from "~/lib/money";

export async function loader({ params, request }: Route.LoaderArgs) {
  const email = await getGuestEmail(request);
  if (!email) throw redirect(`/${params.channelId}/manage`);

  const booking = await getBooking(params.channelId, params.id);
  if (!booking || booking.guest.email.trim().toLowerCase() !== email.trim().toLowerCase()) {
    throw redirect(`/${params.channelId}/manage`);
  }
  return { booking };
}

export function meta() {
  return [{ title: "Your booking" }];
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-2">
      <span className="text-[14px] text-secondary">{label}</span>
      <span className="text-right text-[14px] font-semibold">{value}</span>
    </div>
  );
}

export default function ManageBooking({ loaderData, params }: Route.ComponentProps) {
  const { booking: b } = loaderData;
  const tr = useT();
  const { currency } = useProperty();
  const fmt = (d: string, f: string) => format(parseISO(d), f, { locale: tr.locale });
  const cur = b.currency || currency;

  return (
    <main className="mx-auto max-w-[660px] px-7 pb-20 pt-12">
      <Link
        to={`/${params.channelId}/manage`}
        className="mb-4 inline-block text-[13px] font-semibold text-muted hover:text-accent"
      >
        ← {tr.t("yourBookings")}
      </Link>

      <h1 className="mb-1 font-serif text-[34px] font-medium tracking-[-0.02em]">
        {fmt(b.checkin, "EEE d MMM")} — {fmt(b.checkout, "EEE d MMM yyyy")}
      </h1>
      <div
        className="mb-7 inline-block rounded-full px-[18px] py-2 text-sm font-semibold tracking-[0.04em] text-accent"
        style={{ background: "var(--accent-soft)" }}
      >
        {tr.t("reference")} {b.reference}
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <section className="rounded-[16px] border border-line bg-surface p-5">
          <h2 className="mb-3 font-serif text-[18px] font-semibold">{tr.t("sectionBooking")}</h2>
          <Row label={tr.t("reference")} value={<span className="font-mono text-[13px]">{b.reference}</span>} />
          <Row label={tr.t("checkIn")} value={fmt(b.checkin, "EEE d MMM yyyy")} />
          <Row label={tr.t("checkOut")} value={fmt(b.checkout, "EEE d MMM yyyy")} />
          <Row label={tr.t("nights")} value={String(b.nights)} />
          <Row label={tr.t("bookedOn")} value={fmt(b.createdAt, "d MMM yyyy, HH:mm")} />
        </section>

        <section className="rounded-[16px] border border-line bg-surface p-5">
          <h2 className="mb-3 font-serif text-[18px] font-semibold">{tr.t("sectionGuest")}</h2>
          <Row label={tr.t("guestName")} value={`${b.guest.firstName} ${b.guest.lastName}`} />
          <Row
            label={tr.t("emailAddress")}
            value={
              <a href={`mailto:${b.guest.email}`} className="text-accent hover:underline">
                {b.guest.email}
              </a>
            }
          />
          <Row label={tr.t("phone")} value={b.guest.phone} />
          {b.guest.arrival && <Row label={tr.t("estimatedArrival")} value={b.guest.arrival} />}
          {b.guest.requests && <Row label={tr.t("specialRequests")} value={b.guest.requests} />}
        </section>
      </div>

      <section className="mt-5 rounded-[16px] border border-line bg-surface p-5">
        <h2 className="mb-3 font-serif text-[18px] font-semibold">{tr.t("sectionRooms")}</h2>
        <div className="flex flex-col divide-y divide-divider">
          {b.rooms.map((r, i) => (
            <div key={i} className="flex items-start justify-between gap-4 py-3 first:pt-0">
              <div className="min-w-0">
                <div className="font-semibold">{r.roomTitle}</div>
                <div className="text-[13px] text-muted-2">
                  {r.rateTitle} · {occLabel(tr, r.adults, Array(r.children).fill(8))}
                </div>
              </div>
              <span className="whitespace-nowrap font-semibold">{formatMoney(r.total, cur)}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-baseline justify-between border-t border-divider pt-4">
          <span className="text-[16px] font-semibold">{tr.t("total")}</span>
          <span className="font-serif text-[28px] font-semibold">{formatMoney(b.total, cur)}</span>
        </div>
      </section>

      <section className="mt-5 rounded-[16px] border border-line bg-surface p-5">
        <h2 className="mb-3 font-serif text-[18px] font-semibold">{tr.t("sectionPayment")}</h2>
        <p className="text-[14px] text-muted-2">{tr.t("noPaymentInfo")}</p>
      </section>
    </main>
  );
}
