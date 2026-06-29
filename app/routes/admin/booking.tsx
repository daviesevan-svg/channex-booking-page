import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/booking";
import { BookingStatusBadge } from "~/components/booking-status";
import { cancellationMessage } from "~/lib/cancellation";
import { fmtDate } from "~/lib/dates";
import { makeTranslator } from "~/lib/i18n";
import { getAdminEmail, requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, isOwnerOrSuper } from "~/lib/properties.server";
import { getBooking } from "~/lib/bookings.server";
import { refundBookingCharge } from "~/lib/refunds.server";
import { groupExtrasByRoom } from "~/lib/extras";
import { formatMoney } from "~/lib/money";

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) throw redirect("/admin/bookings");
  const booking = await getBooking(propertyId, params.id);
  if (!booking) throw redirect("/admin/bookings");
  // Only owners/superadmins may issue refunds; controls whether the button shows.
  const canRefund = await isOwnerOrSuper(request, propertyId);
  return { booking, canRefund };
}

export async function action({ params, request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No property selected." };
  const booking = await getBooking(propertyId, params.id);
  if (!booking) return { error: "Booking not found." };

  const form = await request.formData();
  if (form.get("intent") === "refund") {
    // Server-side gate — never trust the hidden button being absent.
    if (!(await isOwnerOrSuper(request, propertyId))) {
      return { error: "Only an owner or manager can issue refunds." };
    }
    const by = (await getAdminEmail(request)) ?? undefined;
    const r = await refundBookingCharge(propertyId, booking, { by });
    if (r.ok) return { refunded: true as const };
    return {
      error:
        r.reason === "already_refunded"
          ? "This booking has already been refunded."
          : r.reason === "no_charge"
            ? "There's no Stripe charge on this booking to refund."
            : "The refund couldn't be processed — check Stripe and try again.",
    };
  }
  return { error: "Unknown action." };
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

export default function AdminBooking({ loaderData, actionData }: Route.ComponentProps) {
  const { booking: b, canRefund } = loaderData;
  const nav = useNavigation();
  const refunding = nav.state !== "idle" && nav.formData?.get("intent") === "refund";
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
          {b.payment?.mode === "payment" && (
            <Row
              label="Payment"
              value={`Paid ${formatMoney(b.payment.amount ?? 0, b.payment.currency || b.currency)} via Stripe`}
            />
          )}
          {b.payment?.mode === "setup" && (
            <Row
              label="Guarantee card"
              value={b.payment.cardLast4 ? `On file ····${b.payment.cardLast4}` : "On file"}
            />
          )}
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

      {b.consent && (
        <section className="mt-5 rounded-[14px] border border-line bg-surface p-5">
          <h2 className="mb-3 font-serif text-[18px] font-semibold">Consent</h2>
          <Row label="Accepted at" value={fmtDate(b.consent.acceptedAt, "d MMM yyyy, HH:mm")} />
          {b.consent.nonRefundableAck != null && (
            <Row label="Non-refundable acknowledged" value={b.consent.nonRefundableAck ? "Yes" : "No"} />
          )}
          <Row label="Marketing opt-in" value={b.consent.marketingOptIn ? "Yes" : "No"} />
          {b.consent.ip && <Row label="IP address" value={b.consent.ip} />}
          {b.consent.userAgent && <Row label="Device" value={b.consent.userAgent} />}
          {b.consent.policyText.length > 0 && (
            <div className="mt-3 border-t border-divider pt-3">
              <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted-2">Policy shown to guest</div>
              <ul className="flex flex-col gap-0.5 text-[13px] text-secondary">
                {b.consent.policyText.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

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
        {b.extras && b.extras.length > 0 && (
          <div className="mt-3 flex flex-col gap-2 border-t border-divider pt-3">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-muted-2">Extras</div>
            {groupExtrasByRoom(b.extras).map((g, gi) => (
              <div key={gi} className="flex flex-col gap-1.5">
                <div className="text-[12.5px] font-semibold text-secondary">{g.roomTitle ?? "For your stay"}</div>
                {g.lines.map((x, i) => (
                  <div key={i} className="flex items-start justify-between gap-3 pl-2 text-[13.5px]">
                    <div className="min-w-0">
                      <span>
                        {x.optionName ? `${x.name} · ${x.optionName}` : x.name}
                        {x.qty > 1 ? ` ×${x.qty}` : ""}
                      </span>
                      {x.infoLine && <div className="text-[12px] text-muted-2">{x.infoLine}</div>}
                    </div>
                    <span className="whitespace-nowrap font-semibold">{formatMoney(x.amount, b.currency)}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {b.offer && (
          <div className="mt-3 flex justify-between text-[13.5px] text-[#3f7a52]">
            <span>{b.offer.name || "Offer"} (−{b.offer.value}%)</span>
            <span className="font-semibold">−{formatMoney(b.offer.discount, b.currency)}</span>
          </div>
        )}
        {b.promo && (
          <div className="mt-3 flex justify-between text-[13.5px] text-[#3f7a52]">
            <span>Promo ({b.promo.code})</span>
            <span className="font-semibold">−{formatMoney(b.promo.discount, b.currency)}</span>
          </div>
        )}
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
        {b.payment ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[14px]">
            {b.payment.mode === "payment" ? (
              <>
                <dt className="text-muted">Status</dt>
                <dd className={b.payment.refund ? "font-semibold text-ink" : "font-semibold text-[#3f7a52]"}>
                  Paid {formatMoney(b.payment.amount ?? 0, b.payment.currency || b.currency)} via Stripe
                </dd>
                {b.payment.refund && (
                  <>
                    <dt className="text-muted">Refunded</dt>
                    <dd className="font-semibold text-[#9a6a1e]">
                      {formatMoney(b.payment.refund.amount, b.payment.refund.currency || b.payment.currency || b.currency)}
                      {" on "}
                      {fmtDate(b.payment.refund.at, "d MMM yyyy")}
                      {b.payment.refund.by && <span className="font-normal text-muted"> · by {b.payment.refund.by}</span>}
                    </dd>
                  </>
                )}
                {b.payment.paymentIntentId && (
                  <>
                    <dt className="text-muted">Payment intent</dt>
                    <dd className="font-mono text-[12px] text-ink">{b.payment.paymentIntentId}</dd>
                  </>
                )}
              </>
            ) : (
              <>
                <dt className="text-muted">Status</dt>
                <dd className="font-semibold text-ink">
                  Guarantee card on file{" "}
                  {b.payment.cardBrand || b.payment.cardLast4 ? (
                    <span className="font-normal text-secondary">
                      ({[b.payment.cardBrand, b.payment.cardLast4 && `····${b.payment.cardLast4}`]
                        .filter(Boolean)
                        .join(" ")}
                      )
                    </span>
                  ) : null}
                </dd>
                <dt className="text-muted">No charge taken</dt>
                <dd className="text-secondary">Payment is collected at the hotel.</dd>
              </>
            )}
            <dt className="text-muted">Stripe account</dt>
            <dd className="font-mono text-[12px] text-ink">{b.payment.accountId}</dd>
            <dt className="text-muted">Checkout session</dt>
            <dd className="font-mono text-[12px] text-ink">{b.payment.sessionId}</dd>
          </dl>
        ) : (
          <p className="text-[14px] text-muted-2">No payment information captured yet.</p>
        )}

        {b.payment?.mode === "payment" && !b.payment.refund && canRefund && (
          <Form
            method="post"
            className="mt-4 border-t border-divider pt-4"
            onSubmit={(e) => {
              if (!confirm(`Refund ${formatMoney(b.payment!.amount ?? 0, b.payment!.currency || b.currency)} to the guest? This can't be undone.`))
                e.preventDefault();
            }}
          >
            <input type="hidden" name="intent" value="refund" />
            <button
              type="submit"
              disabled={refunding}
              className="rounded-[10px] border border-line-alt bg-surface px-4 py-2.5 text-[14px] font-semibold text-secondary hover:border-accent hover:text-accent disabled:opacity-60"
            >
              {refunding ? "Refunding…" : `Refund ${formatMoney(b.payment.amount ?? 0, b.payment.currency || b.currency)}`}
            </button>
            <p className="mt-2 text-[12.5px] text-muted">Issues a full refund via Stripe to the original card.</p>
          </Form>
        )}
        {actionData?.error && (
          <p className="mt-3 rounded-[10px] border border-red-200 bg-red-50 px-3.5 py-2.5 text-[13px] text-red-700">
            {actionData.error}
          </p>
        )}
        {actionData?.refunded && (
          <p className="mt-3 rounded-[10px] border border-[#cfe3d0] bg-[#eef5ec] px-3.5 py-2.5 text-[13px] text-[#3f7a52]">
            ✓ Refund issued.
          </p>
        )}
      </section>
    </div>
  );
}
