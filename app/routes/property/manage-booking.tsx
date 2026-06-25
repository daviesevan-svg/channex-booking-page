import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/manage-booking";
import { useProperty } from "~/lib/booking-context";
import { getBooking, stayAvailabilityItems, updateBooking } from "~/lib/bookings.server";
import { incrementAvailability } from "~/lib/ari.server";
import { getSettings } from "~/lib/overrides.server";
import { getGuestEmail } from "~/lib/guest-auth.server";
import { cancellationMessage } from "~/lib/cancellation";
import { fmtDate } from "~/lib/dates";
import { occLabel, useT } from "~/lib/i18n";
import { formatMoney } from "~/lib/money";

async function ownedBooking(channelId: string, id: string, request: Request) {
  const email = await getGuestEmail(request);
  if (!email) return null;
  const booking = await getBooking(channelId, id);
  if (!booking || booking.guest.email.trim().toLowerCase() !== email.trim().toLowerCase()) {
    return null;
  }
  return booking;
}

type CancelReason = "ok" | "notAllowed" | "nonRefundable" | "deadline";

/** Whether a guest may self-cancel right now, and if not, why (for the tooltip). */
function cancelState(
  booking: NonNullable<Awaited<ReturnType<typeof getBooking>>>,
  allowCancel: boolean,
): { canCancel: boolean; reason: CancelReason } {
  if (!allowCancel) return { canCancel: false, reason: "notAllowed" };
  const c = booking.cancellation;
  if (c && c.refundable === false) return { canCancel: false, reason: "nonRefundable" };
  if (c?.cancelByISO && Date.now() > Date.parse(c.cancelByISO)) {
    return { canCancel: false, reason: "deadline" };
  }
  return { canCancel: true, reason: "ok" };
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const booking = await ownedBooking(params.channelId, params.id, request);
  if (!booking) throw redirect(`/${params.channelId}/manage`);

  const settings = await getSettings(params.channelId);
  const { canCancel, reason } = cancelState(booking, Boolean(settings.allowCancel));
  return {
    booking,
    canCancel,
    cancelReason: reason,
    afterDeadlineMessage: settings.afterDeadlineMessage,
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const booking = await ownedBooking(params.channelId, params.id, request);
  if (!booking) throw redirect(`/${params.channelId}/manage`);

  const form = await request.formData();
  if (form.get("intent") === "cancel") {
    const settings = await getSettings(params.channelId);
    // Re-check server-side so a stale page can't cancel past the deadline.
    const active = (booking.lifecycle ?? "active") === "active";
    if (active && cancelState(booking, Boolean(settings.allowCancel)).canCancel) {
      await updateBooking(params.channelId, booking.id, {
        lifecycle: "cancelled",
        cancelledAt: new Date().toISOString(),
        inventoryHeld: false,
      });
      // Give the nights back to inventory (only if this booking held them).
      if (booking.inventoryHeld) {
        await incrementAvailability(
          params.channelId,
          stayAvailabilityItems(booking.rooms, booking.checkin, booking.nights),
        );
      }
    }
  }
  return redirect(`/${params.channelId}/manage/${params.id}`);
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
  const { booking: b, canCancel, cancelReason, afterDeadlineMessage } = loaderData;
  const tr = useT();
  const { currency } = useProperty();
  const nav = useNavigation();
  const fmt = (d: string, f: string) => fmtDate(d, f, tr.locale);
  const cur = b.currency || currency;
  const cancelled = (b.lifecycle ?? "active") === "cancelled";
  const cancelling = nav.state === "submitting";
  const cancelTip =
    cancelReason === "nonRefundable"
      ? tr.t("nonRefundableNotice")
      : cancelReason === "deadline"
        ? afterDeadlineMessage || tr.t("cancelUnavailable")
        : cancelReason === "notAllowed"
          ? tr.t("cancelNotAllowed")
          : "";

  const msg = cancellationMessage(b.cancellation, Date.now());
  const cancellationText = msg
    ? tr.t(msg.key, "iso" in msg ? { date: fmt(msg.iso, "EEE d MMM yyyy") } : undefined)
    : "";

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
      <div className="mb-7 flex flex-wrap items-center gap-2.5">
        <span
          className="inline-block rounded-full px-[18px] py-2 text-sm font-semibold tracking-[0.04em] text-accent"
          style={{ background: "var(--accent-soft)" }}
        >
          {tr.t("reference")} {b.reference}
        </span>
        {cancelled && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#fbe9e7] px-3 py-1.5 text-[13px] font-semibold text-[#c0392b]">
            ✕ {tr.t("statusCancelled")}
          </span>
        )}
      </div>

      {cancelled && (
        <div className="mb-6 rounded-[12px] border border-[#f3d0ca] bg-[#fbe9e7] px-4 py-3 text-[14px] text-[#c0392b]">
          {tr.t("bookingCancelled")}
        </div>
      )}

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
        {b.promo && (
          <div className="mt-3 flex justify-between text-[14px] text-[#3f7a52]">
            <span>
              {tr.t("discount")} ({b.promo.code})
            </span>
            <span className="font-semibold">−{formatMoney(b.promo.discount, cur)}</span>
          </div>
        )}
        <div className="mt-4 flex items-baseline justify-between border-t border-divider pt-4">
          <span className="text-[16px] font-semibold">{tr.t("total")}</span>
          <span className="font-serif text-[28px] font-semibold">{formatMoney(b.total, cur)}</span>
        </div>
      </section>

      {cancellationText && (
        <section className="mt-5 rounded-[16px] border border-line bg-surface p-5">
          <h2 className="mb-2 font-serif text-[18px] font-semibold">{tr.t("cancellationPolicy")}</h2>
          <p className="text-[14px] text-secondary">{cancellationText}</p>
        </section>
      )}

      <section className="mt-5 rounded-[16px] border border-line bg-surface p-5">
        <h2 className="mb-3 font-serif text-[18px] font-semibold">{tr.t("sectionPayment")}</h2>
        <p className="text-[14px] text-muted-2">{tr.t("noPaymentInfo")}</p>
      </section>

      {!cancelled && (
        <Form
          method="post"
          className="mt-6"
          onSubmit={(e) => {
            if (!canCancel || !confirm(tr.t("cancelConfirm"))) e.preventDefault();
          }}
        >
          <button
            type="submit"
            name="intent"
            value="cancel"
            disabled={!canCancel || cancelling}
            title={!canCancel ? cancelTip : undefined}
            aria-disabled={!canCancel}
            className="rounded-[12px] border border-[#e0b4ac] bg-surface px-6 py-3 text-[15px] font-semibold text-[#c0392b] transition-colors hover:bg-[#fbe9e7] disabled:cursor-not-allowed disabled:border-line-alt disabled:bg-surface-alt disabled:text-muted-2 disabled:hover:bg-surface-alt"
          >
            {cancelling ? tr.t("cancelling") : tr.t("cancelBooking")}
          </button>
          {!canCancel && cancelTip && (
            <p className="mt-2 text-[12.5px] text-muted-2">{cancelTip}</p>
          )}
        </Form>
      )}
    </main>
  );
}
