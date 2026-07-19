// Buyer self-service for a voucher, behind the same guest-session login as
// manage-my-booking (the buyer's email is the credential — the public
// /voucher/:code page stays read-only for whoever holds the code).
//
// Actions: send the recipient a reminder (gift purchases), and cancel for a
// full refund inside the property's cooling-off window (EU distance-selling
// style; default 14 days, auto Stripe refund).
import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/manage-voucher";
import { fmtDate } from "~/lib/dates";
import { useProperty } from "~/lib/booking-context";
import { useT } from "~/lib/i18n";
import { formatMoney } from "~/lib/money";
import { getGuestEmail } from "~/lib/guest-auth.server";
import { resolvePropertyId } from "~/lib/properties.server";
import { getSettings } from "~/lib/overrides.server";
import { getBooking } from "~/lib/bookings.server";
import { clientKey, rateLimit } from "~/lib/rate-limit.server";
import {
  coolingOffEndsAt,
  DEFAULT_COOLING_OFF_DAYS,
  displayStatus,
  giftBalance,
  normalizeVoucherCode,
  selfCancelDisallowedReason,
  type VoucherRecord,
} from "~/lib/vouchers";
import {
  getVoucherByCode,
  refundVoucherCharge,
  selfCancelVoucher,
  setGiftRecipientEmail,
} from "~/lib/vouchers.server";
import { sendVoucherCancelEmails, sendVoucherReminderEmail } from "~/lib/voucher-purchase.server";

/** Voucher owned by the signed-in buyer, or a redirect back to the login. */
async function requireOwnVoucher(
  request: Request,
  channelId: string,
  code: string,
): Promise<{ pid: string; email: string; v: VoucherRecord }> {
  const base = `/${channelId}/manage`;
  const email = await getGuestEmail(request);
  if (!email) throw redirect(base);
  const pid = await resolvePropertyId(channelId);
  const v = await getVoucherByCode(pid, normalizeVoucherCode(code));
  if (!v || v.buyer.email.trim().toLowerCase() !== email.toLowerCase()) throw redirect(base);
  return { pid, email, v };
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const { pid, v } = await requireOwnVoucher(request, params.channelId, params.code);
  const settings = await getSettings(pid);
  const days = settings.voucherCoolingOffDays ?? DEFAULT_COOLING_OFF_DAYS;
  const reason = selfCancelDisallowedReason(v, days);
  const now = Date.now();

  // A redeemed package links its booking — surface the stay reference.
  const bookingId = v.redemptions.find((r) => r.bookingId)?.bookingId;
  const booking = bookingId ? await getBooking(pid, bookingId).catch(() => null) : null;

  // Settled activity only (live checkout holds are invisible plumbing).
  const activity = v.redemptions
    .filter((r) => r.bookingId || r.note || (r.amount != null && !r.pendingUntil))
    .map((r) => ({
      at: r.at,
      amount: r.amount,
      type:
        r.note === "cooling-off cancel"
          ? ("cancelled" as const)
          : v.kind === "package" && r.bookingId
            ? ("booked" as const)
            : ("spent" as const),
    }));

  return {
    voucher: {
      code: v.code,
      kind: v.kind,
      status: displayStatus(v, now),
      title: v.product.title,
      price: v.product.price,
      value: v.product.value,
      balance: v.kind === "gift" ? giftBalance(v, now) : undefined,
      purchasedAt: v.purchasedAt,
      expiresAt: v.expiresAt,
      gift: v.gift
        ? { recipientName: v.gift.recipientName, recipientEmail: v.gift.recipientEmail }
        : undefined,
      refund: v.payment?.refund ? { amount: v.payment.refund.amount, at: v.payment.refund.at } : undefined,
      hasCharge: Boolean(v.payment?.paymentIntentId),
      chargedAmount: v.payment?.amount ?? v.product.price,
      bookingReference: booking?.reference,
      activity,
    },
    canCancel: !reason,
    cancelReason: reason,
    cancelBy: new Date(coolingOffEndsAt(v, days)).toISOString(),
    canRemind: Boolean(v.gift) && displayStatus(v, now) === "active",
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const { pid, email, v } = await requireOwnVoucher(request, params.channelId, params.code);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "cancel") {
    if (!(await rateLimit(`vcancel:${pid}:${clientKey(request)}`, 5, 600))) {
      return { cancelError: "conflict" as const };
    }
    const settings = await getSettings(pid);
    const days = settings.voucherCoolingOffDays ?? DEFAULT_COOLING_OFF_DAYS;
    const r = await selfCancelVoucher(pid, v.code, days, `buyer ${email}`);
    if (!r.ok) return { cancelError: r.reason };

    let refundAmount: number | undefined;
    let refundFailed = false;
    if (v.payment?.paymentIntentId) {
      const rr = await refundVoucherCharge(pid, r.voucher, "buyer (cooling-off)");
      if (rr.ok) refundAmount = rr.amount;
      else if (rr.reason === "error") refundFailed = true;
    }
    await sendVoucherCancelEmails(pid, r.voucher, { refundAmount, refundFailed });
    // The loader revalidates after the action — it re-reads the cancelled
    // voucher (and the recorded refund); only the failure flag needs passing.
    return { cancelled: true as const, refundFailed };
  }

  if (intent === "remind") {
    if (!v.gift || displayStatus(v) !== "active") return { remindError: "failed" as const };

    let target = v.gift.recipientEmail;
    const newEmail = String(form.get("recipientEmail") ?? "").trim();
    if (newEmail && newEmail !== target) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) return { remindError: "invalidEmail" as const };
      await setGiftRecipientEmail(pid, v.code, newEmail);
      target = newEmail;
    }
    if (!target) return { remindError: "noEmail" as const };

    if (!(await rateLimit(`vremind:${pid}:${v.code}`, 3, 86400))) {
      return { remindError: "tooMany" as const };
    }
    const fresh = (await getVoucherByCode(pid, v.code)) ?? v;
    const sent = await sendVoucherReminderEmail(pid, fresh, new URL(request.url).origin, params.channelId);
    return sent ? { reminded: target } : { remindError: "failed" as const };
  }

  return null;
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData ? `Voucher ${loaderData.voucher.code}` : "Voucher" }];
}

const STATUS_STYLE: Record<string, string> = {
  active: "bg-[#e8f0e6] text-[#3f7a52]",
  redeemed: "bg-chip text-muted",
  cancelled: "bg-[#fbe9e7] text-[#c0392b]",
  expired: "bg-[#fbe9e7] text-[#c0392b]",
};

export default function ManageVoucher({ loaderData, actionData, params }: Route.ComponentProps) {
  const { voucher: v, canCancel, cancelReason, cancelBy, canRemind } = loaderData;
  const tr = useT();
  const { currency } = useProperty();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const money = (n: number) => formatMoney(n, currency);
  const date = (iso: string) => fmtDate(iso, "d MMM yyyy", tr.locale);
  const card = "rounded-[16px] border border-line bg-surface p-6";
  const inputCls =
    "mt-1.5 block w-full rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-2.5 text-[15px] text-ink outline-none focus:border-accent";

  const remindError = actionData && "remindError" in actionData ? actionData.remindError : undefined;
  const reminded = actionData && "reminded" in actionData ? actionData.reminded : undefined;
  const cancelError = actionData && "cancelError" in actionData ? actionData.cancelError : undefined;
  const refundFailed = Boolean(actionData && "refundFailed" in actionData && actionData.refundFailed);

  return (
    <main className="mx-auto max-w-[760px] px-7 pb-20 pt-12">
      <Link
        to={`/${params.channelId}/manage`}
        className="mb-5 inline-block text-sm font-semibold text-muted hover:text-accent"
      >
        ← {tr.t("manageVouchersTitle")}
      </Link>

      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h1 className="font-serif text-[34px] font-medium tracking-[-0.02em]">{v.title}</h1>
        <span
          className={`rounded-full px-3 py-1.5 text-[12px] font-semibold ${STATUS_STYLE[v.status] ?? "bg-chip text-muted"}`}
        >
          {tr.t(`voucherStatus_${v.status}`)}
        </span>
      </div>
      <p className="mb-7 text-[14px] text-muted-2">
        {v.code} · {tr.t("voucherPurchasedOn", { date: date(v.purchasedAt) })} ·{" "}
        {tr.t("voucherValidUntil", { date: date(v.expiresAt) })}
        {v.gift?.recipientName ? ` · ${tr.t("manageVoucherFor", { name: v.gift.recipientName })}` : ""}
      </p>

      <div className="flex flex-col gap-4">
        {/* Balance / redemption state */}
        <div className={card}>
          {v.kind === "gift" ? (
            <div className="flex items-baseline justify-between">
              <span className="text-[14px] font-semibold text-secondary">{tr.t("voucherBalance")}</span>
              <span className="font-serif text-[28px] font-semibold">{money(v.balance ?? 0)}</span>
            </div>
          ) : (
            <div className="flex items-baseline justify-between">
              <span className="text-[14px] font-semibold text-secondary">
                {tr.t(`voucherStatus_${v.status}`)}
                {v.bookingReference ? ` · ${tr.t("reference")} ${v.bookingReference}` : ""}
              </span>
              <span className="font-serif text-[28px] font-semibold">{money(v.price)}</span>
            </div>
          )}

          {v.activity.length > 0 && (
            <div className="mt-4 border-t border-divider pt-4">
              <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.1em] text-muted-2">
                {tr.t("voucherManageActivity")}
              </div>
              {v.activity.map((a, i) => (
                <div key={i} className="flex items-center justify-between py-1 text-[14px] text-secondary">
                  <span>
                    {a.type === "cancelled"
                      ? tr.t("voucherStatus_cancelled")
                      : a.type === "booked"
                        ? tr.t("voucherActivityBooked")
                        : tr.t("voucherActivitySpent", { amount: a.amount != null ? money(a.amount) : "" })}
                  </span>
                  <span className="text-muted-2">{date(a.at)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 border-t border-divider pt-4 text-[13px]">
            <Link to={`/${params.channelId}/voucher/${v.code}`} className="font-semibold text-accent hover:text-accent-deep">
              {tr.t("manageVoucherOpen")} →
            </Link>
          </div>
        </div>

        {/* Reminder to the recipient */}
        {canRemind && v.gift && (
          <div className={card}>
            <h2 className="m-0 mb-1.5 font-serif text-[20px] font-semibold">{tr.t("voucherRemindTitle")}</h2>
            <p className="m-0 mb-4 text-[14px] leading-[1.6] text-secondary">
              {tr.t("voucherRemindBody", { name: v.gift.recipientName })}
            </p>
            <Form method="post" className="flex flex-col gap-3">
              <input type="hidden" name="intent" value="remind" />
              {!v.gift.recipientEmail && (
                <label className="block text-[13px] font-semibold text-secondary">
                  {tr.t("voucherRemindEmailLabel")}
                  <input name="recipientEmail" type="email" required className={inputCls} />
                </label>
              )}
              {reminded && <p className="m-0 text-[13px] font-semibold text-[#3f7a52]">{tr.t("voucherRemindSent", { email: reminded })}</p>}
              {remindError && (
                <p className="m-0 text-[13px] text-red-600">
                  {remindError === "tooMany"
                    ? tr.t("voucherRemindTooMany")
                    : remindError === "noEmail" || remindError === "invalidEmail"
                      ? tr.t("voucherRemindNoEmail")
                      : tr.t("voucherRemindFailed")}
                </p>
              )}
              <button
                type="submit"
                disabled={busy}
                className="self-start rounded-[11px] border border-line-alt px-5 py-2.5 text-[14px] font-semibold text-secondary transition-colors hover:bg-chip disabled:opacity-60"
              >
                {tr.t("voucherRemindButton")}
              </button>
            </Form>
          </div>
        )}

        {/* Cancel for a refund (cooling-off) */}
        <div className={card}>
          <h2 className="m-0 mb-1.5 font-serif text-[20px] font-semibold">{tr.t("voucherCancelTitle")}</h2>
          {v.status === "cancelled" ? (
            <p className="m-0 text-[14px] leading-[1.6] text-secondary">
              {tr.t("voucherCancelledNote")}{" "}
              {v.refund
                ? tr.t("voucherRefundedNote", { amount: money(v.refund.amount), date: date(v.refund.at) })
                : refundFailed || v.hasCharge
                  ? tr.t("voucherRefundManualNote")
                  : ""}
            </p>
          ) : canCancel ? (
            <Form
              method="post"
              onSubmit={(e) => {
                if (!confirm(tr.t("voucherCancelConfirm"))) e.preventDefault();
              }}
              className="flex flex-col gap-3"
            >
              <input type="hidden" name="intent" value="cancel" />
              <p className="m-0 text-[14px] leading-[1.6] text-secondary">
                {v.hasCharge
                  ? tr.t("voucherCancelWindow", { date: date(cancelBy), amount: money(v.chargedAmount) })
                  : tr.t("voucherCancelWindowFree", { date: date(cancelBy) })}
              </p>
              {cancelError && (
                <p className="m-0 text-[13px] text-red-600">
                  {cancelError === "conflict" ? tr.t("voucherCancelFailed") : tr.t(`voucherCancelReason_${cancelError}`)}
                </p>
              )}
              <button
                type="submit"
                disabled={busy}
                className="self-start rounded-[11px] border border-[#e5c4bd] px-5 py-2.5 text-[14px] font-semibold text-[#c0392b] transition-colors hover:bg-[#fbe9e7] disabled:opacity-60"
              >
                {busy ? "…" : tr.t("voucherCancelButton")}
              </button>
            </Form>
          ) : (
            <p className="m-0 text-[14px] leading-[1.6] text-secondary">
              {tr.t(`voucherCancelReason_${cancelReason ?? "window"}`)}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
