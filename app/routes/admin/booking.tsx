import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/booking";
import { BookingStatusBadge } from "~/components/booking-status";
import { cancellationMessage } from "~/lib/cancellation";
import { fmtDate } from "~/lib/dates";
import { makeTranslator } from "~/lib/i18n";
import { getAdminEmail, requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, isOwnerOrSuper } from "~/lib/properties.server";
import { getBooking, stayAvailabilityItems, updateBooking } from "~/lib/bookings.server";
import { cancelChannexBooking, payloadWithGuest, pushGuestModification, retryChannexPush } from "~/lib/booking-finalize.server";
import { FIELD_INPUT } from "~/components/admin-form";
import { incrementAvailability } from "~/lib/ari.server";
import { sendCancellationEmails, sendGuestBookingEmail } from "~/lib/email.server";
import { dispatchWebhook } from "~/lib/webhooks.server";
import { serializeBooking } from "~/lib/api-serialize";
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
  const intent = form.get("intent");

  if (intent === "retry") {
    const r = await retryChannexPush(propertyId, booking, new URL(request.url).origin);
    if (r.ok) return { retried: true as const };
    return {
      error:
        r.reason === "not_failed"
          ? "Only a failed booking can be retried."
          : r.reason === "no_payload"
            ? "No stored Channex payload to retry (legacy failed booking)."
            : `Channex rejected it again: ${r.error}`,
    };
  }

  if (intent === "resendEmail") {
    // Re-send the guest confirmation (e.g. after fixing content or a mail
    // hiccup). Confirmation only makes sense for a booking that stands.
    if (booking.status === "failed") return { error: "This booking isn't confirmed — retry the Channex push first." };
    if ((booking.lifecycle ?? "active") !== "active") return { error: "This booking is cancelled — there's no confirmation to resend." };
    const sent = await sendGuestBookingEmail(propertyId, booking, new URL(request.url).origin);
    return sent
      ? { emailResent: true as const }
      : { error: "The email couldn't be sent — check the email settings (SparkPost key / sender)." };
  }

  if (intent === "editGuest") {
    // Fix typos in the guest's contact details (wrong email = no confirmation,
    // no portal access, no review request). Contact details only — never the
    // stay or the money. Every change lands in the record's audit trail.
    if ((booking.lifecycle ?? "active") !== "active") {
      return { error: "This booking is cancelled — guest details can no longer be edited." };
    }
    const next = {
      firstName: String(form.get("firstName") ?? "").trim(),
      lastName: String(form.get("lastName") ?? "").trim(),
      email: String(form.get("email") ?? "").trim(),
      phone: String(form.get("phone") ?? "").trim(),
    };
    if (!next.firstName || !next.lastName) return { error: "First and last name are required." };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) return { error: "That email address doesn't look valid." };

    const fields = ["firstName", "lastName", "email", "phone"] as const;
    const changes = fields
      .filter((f) => next[f] !== (booking.guest[f] ?? ""))
      .map((f) => ({ field: f, from: booking.guest[f] ?? "", to: next[f] }));
    if (changes.length === 0) return { error: "Nothing changed." };
    const emailChanged = changes.some((c) => c.field === "email");

    const by = (await getAdminEmail(request)) ?? undefined;
    const guest = { ...booking.guest, ...next };
    // Also patch the stored Channex payload so any later revision (cancellation)
    // carries the corrected details too.
    const patchedPayload = payloadWithGuest(booking.channexPayload, guest);
    const updated =
      (await updateBooking(propertyId, booking.id, {
        guest,
        edits: [...(booking.edits ?? []), { at: new Date().toISOString(), by, changes }],
        ...(patchedPayload ? { channexPayload: patchedPayload } : {}),
      })) ?? booking;

    // Tell Channex (status "modified", same payload) so the PMS copy is corrected.
    // Best-effort: the local edit stands either way; a failure is surfaced below.
    const push = await pushGuestModification(propertyId, updated);
    const pushWarning =
      booking.channexId && !push.pushed
        ? `Saved here, but the update couldn't be sent to Channex — the PMS copy keeps the old details. (${push.error ?? "push failed"})`
        : undefined;

    let emailResent = false;
    if (emailChanged && form.get("resend") === "1" && updated.status !== "failed") {
      emailResent = await sendGuestBookingEmail(propertyId, updated, new URL(request.url).origin);
    }
    return { guestEdited: true as const, pushWarning, emailResent: emailResent || undefined };
  }

  if (intent === "cancel") {
    if ((booking.lifecycle ?? "active") !== "active") {
      return { error: "This booking is already cancelled." };
    }
    const by = (await getAdminEmail(request)) ?? undefined;
    const updated = await updateBooking(propertyId, booking.id, {
      lifecycle: "cancelled",
      cancelledAt: new Date().toISOString(),
      cancelledBy: by,
      inventoryHeld: false,
    });
    // Give the nights back to inventory (only if this booking held them).
    if (booking.inventoryHeld) {
      await incrementAvailability(propertyId, stayAvailabilityItems(booking.rooms, booking.checkin, booking.nights));
    }
    // Cancel upstream in Channex too (best-effort) for a live booking.
    await cancelChannexBooking(propertyId, booking);
    const finalBooking = updated ?? booking;
    await sendCancellationEmails(propertyId, finalBooking, new URL(request.url).origin);
    await dispatchWebhook(propertyId, "booking.cancelled", serializeBooking(finalBooking), Date.now());
    return { cancelled: true as const };
  }

  if (intent === "refund") {
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

const FIELD_LABELS: Record<string, string> = {
  firstName: "First name",
  lastName: "Last name",
  email: "Email",
  phone: "Phone",
};

export default function AdminBooking({ loaderData, actionData }: Route.ComponentProps) {
  const { booking: b, canRefund } = loaderData;
  const nav = useNavigation();
  const intent = nav.formData?.get("intent");
  const refunding = nav.state !== "idle" && intent === "refund";
  const retrying = nav.state !== "idle" && intent === "retry";
  const resending = nav.state !== "idle" && intent === "resendEmail";
  const cancelling = nav.state !== "idle" && intent === "cancel";
  const editingGuest = nav.state !== "idle" && intent === "editGuest";
  const active = (b.lifecycle ?? "active") === "active";
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
          Cancelled {b.cancelledBy ? `by ${b.cancelledBy}` : "by the guest"} on{" "}
          {fmtDate(b.cancelledAt, "d MMM yyyy, HH:mm")}.
        </div>
      )}

      {actionData?.retried && (
        <div className="mb-5 rounded-[12px] border border-[#cfe3d0] bg-[#eef5ec] px-4 py-3 text-[13.5px] font-medium text-[#3f7a52]">
          ✓ Sent to Channex — the booking is now confirmed.
        </div>
      )}
      {actionData?.cancelled && (
        <div className="mb-5 rounded-[12px] border border-[#f3d0ca] bg-[#fbe9e7] px-4 py-3 text-[13.5px] font-medium text-[#c0392b]">
          Booking cancelled. A cancellation email has been sent to the guest.
        </div>
      )}
      {actionData?.emailResent && (
        <div className="mb-5 rounded-[12px] border border-[#cfe3d0] bg-[#eef5ec] px-4 py-3 text-[13.5px] font-medium text-[#3f7a52]">
          ✓ Confirmation email re-sent to {b.guest.email}.
        </div>
      )}
      {actionData?.guestEdited && (
        <div className="mb-5 rounded-[12px] border border-[#cfe3d0] bg-[#eef5ec] px-4 py-3 text-[13.5px] font-medium text-[#3f7a52]">
          ✓ Guest details updated.
        </div>
      )}
      {actionData?.pushWarning && (
        <div className="mb-5 rounded-[12px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13.5px] text-amber-900">
          {actionData.pushWarning}
        </div>
      )}

      {b.status === "failed" && (
        <div className="mb-5 rounded-[12px] border border-red-200 bg-red-50 px-4 py-3 text-[13.5px] text-red-700">
          <p>
            <span className="font-semibold">Not confirmed:</span>{" "}
            {b.error ?? "This booking wasn't sent to Channex."}
          </p>
          {b.payment?.refund && (
            <p className="mt-1 font-medium">The payment was automatically refunded to the guest.</p>
          )}
          {/* Retry only makes sense for a (possibly transient) push failure that
              still has its payload — not when the rooms sold out. */}
          {b.channexPayload != null && (
            <Form method="post" className="mt-2.5">
              <input type="hidden" name="intent" value="retry" />
              <button
                type="submit"
                disabled={retrying}
                className="rounded-[10px] border border-red-300 bg-white px-4 py-2 text-[13px] font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60"
              >
                {retrying ? "Retrying…" : "Retry sending to Channex"}
              </button>
            </Form>
          )}
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

          {/* Contact-detail fixes (typo'd email = no confirmation, no portal,
              no review request). Contact only — never the stay or the money. */}
          {active && (
            <details className="mt-3 border-t border-divider pt-3">
              <summary className="cursor-pointer text-[13px] font-semibold text-secondary hover:text-accent">
                Edit guest details
              </summary>
              <Form method="post" className="mt-3 space-y-3">
                <input type="hidden" name="intent" value="editGuest" />
                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-[12.5px] font-semibold text-secondary">
                    First name
                    <input name="firstName" defaultValue={b.guest.firstName} required className={FIELD_INPUT} />
                  </label>
                  <label className="block text-[12.5px] font-semibold text-secondary">
                    Last name
                    <input name="lastName" defaultValue={b.guest.lastName} required className={FIELD_INPUT} />
                  </label>
                </div>
                <label className="block text-[12.5px] font-semibold text-secondary">
                  Email
                  <input name="email" type="email" defaultValue={b.guest.email} required className={FIELD_INPUT} />
                </label>
                <label className="block text-[12.5px] font-semibold text-secondary">
                  Phone
                  <input name="phone" defaultValue={b.guest.phone} className={FIELD_INPUT} />
                </label>
                <label className="flex items-center gap-2 text-[13px] text-secondary">
                  <input type="checkbox" name="resend" value="1" defaultChecked />
                  Email the confirmation to the corrected address (when the email changed)
                </label>
                <button
                  type="submit"
                  disabled={editingGuest}
                  className="rounded-[10px] bg-accent px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
                >
                  {editingGuest ? "Saving…" : "Save guest details"}
                </button>
              </Form>
            </details>
          )}

          {/* Audit trail — the record as consented at checkout stays reconstructible. */}
          {(b.edits?.length ?? 0) > 0 && (
            <div className="mt-3 border-t border-divider pt-3">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-2">Edit history</div>
              {b.edits!.map((e, i) => (
                <div key={i} className="mb-1.5 text-[12px] text-muted">
                  <span className="text-muted-2">
                    {fmtDate(e.at, "d MMM yyyy, HH:mm")}
                    {e.by ? ` · ${e.by}` : ""}
                  </span>
                  {e.changes.map((c) => (
                    <div key={c.field}>
                      {FIELD_LABELS[c.field] ?? c.field}: <s>{c.from || "—"}</s> → {c.to || "—"}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
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
        {/* Taxes & fees charged on top of the room prices (snapshotted at
            booking time; absent on legacy bookings). */}
        {b.pricing && (b.pricing.charges.length > 0 || b.pricing.taxLines.length > 0) && (
          <div className="mt-3 flex flex-col gap-1.5 border-t border-divider pt-3">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-muted-2">Taxes &amp; fees</div>
            {[...b.pricing.charges, ...b.pricing.taxLines].map((c, i) => (
              <div key={i} className="flex justify-between text-[13.5px]">
                <span>{c.label}</span>
                <span className="whitespace-nowrap font-semibold">{formatMoney(c.amount, b.currency)}</span>
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
        {b.pricing && b.pricing.taxIncluded > 0 && (
          <div className="mt-1 text-right text-[12px] text-muted-2">
            Includes {formatMoney(b.pricing.taxIncluded, b.currency)} VAT
          </div>
        )}
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

      {active && (
        <section className="mt-5 rounded-[14px] border border-line bg-surface p-5">
          <h2 className="mb-3 font-serif text-[18px] font-semibold">Manage booking</h2>
          <div className="flex flex-wrap items-start gap-6">
            {/* Re-send the guest confirmation — e.g. after fixing email content
                or a delivery hiccup. Not for failed bookings (retry the push). */}
            {b.status !== "failed" && (
              <Form method="post">
                <input type="hidden" name="intent" value="resendEmail" />
                <button
                  type="submit"
                  disabled={resending}
                  className="rounded-[10px] border border-line-alt bg-surface px-4 py-2.5 text-[14px] font-semibold text-secondary hover:border-accent hover:text-accent disabled:opacity-60"
                >
                  {resending ? "Sending…" : "Resend confirmation email"}
                </button>
                <p className="mt-2 text-[12.5px] text-muted">
                  Re-sends the booking confirmation to {b.guest.email}.
                </p>
              </Form>
            )}
            {b.status !== "failed" && (
              <div>
                {/* Plain <a>, not <Link> — a resource route serving a file download. */}
                <a
                  href={`/admin/bookings/${b.id}/pdf`}
                  className="inline-block rounded-[10px] border border-line-alt bg-surface px-4 py-2.5 text-[14px] font-semibold text-secondary hover:border-accent hover:text-accent"
                >
                  Download confirmation (PDF)
                </a>
                <p className="mt-2 text-[12.5px] text-muted">
                  Print it or send it to the guest yourself if the email didn't arrive.
                </p>
              </div>
            )}
            <Form
              method="post"
              onSubmit={(e) => {
                if (!confirm("Cancel this booking? The guest will be emailed and the nights returned to inventory. This can't be undone.")) {
                  e.preventDefault();
                }
              }}
            >
              <input type="hidden" name="intent" value="cancel" />
              <button
                type="submit"
                disabled={cancelling}
                className="rounded-[10px] border border-[#e0b4ab] bg-surface px-4 py-2.5 text-[14px] font-semibold text-[#c0392b] hover:bg-[#fbe9e7] disabled:opacity-60"
              >
                {cancelling ? "Cancelling…" : "Cancel booking"}
              </button>
              <p className="mt-2 text-[12.5px] text-muted">
                Marks the booking cancelled, emails the guest, and frees the inventory. Issue a refund
                separately (Payment section above) if one is due.
              </p>
            </Form>
          </div>
        </section>
      )}
    </div>
  );
}
