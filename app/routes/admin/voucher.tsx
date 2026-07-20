// Admin · Voucher detail — one sold voucher, the way /admin/bookings/:id shows
// one booking: full product snapshot, buyer/recipient, payment + refund, an
// activity timeline (with links into redeemed bookings), and every management
// action that used to be crammed into the sold-tab table.
import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/voucher";
import { FIELD_INPUT } from "~/components/admin-form";
import { BlockedRangesEditor } from "~/components/blocked-ranges";
import { fmtDate } from "~/lib/dates";
import { getAdminEmail, requireAdmin } from "~/lib/auth.server";
import { currentPropertyId, getProperty, isOwnerOrSuper } from "~/lib/properties.server";
import { getSettings } from "~/lib/overrides.server";
import { getBooking } from "~/lib/bookings.server";
import { formatMoney } from "~/lib/money";
import { blockedRangesToText, displayStatus, giftBalance, normalizeVoucherCode, parseBlockedRanges, WEEKDAY_LABELS } from "~/lib/vouchers";
import {
  cancelVoucher,
  deductGift,
  getVoucherByCode,
  manualRedeemVoucher,
  refundVoucherCharge,
  updateVoucherTerms,
} from "~/lib/vouchers.server";
import { sendVoucherEmails } from "~/lib/voucher-purchase.server";

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) throw redirect("/admin/vouchers?tab=sold");
  const v = await getVoucherByCode(propertyId, normalizeVoucherCode(params.code));
  if (!v) throw redirect("/admin/vouchers?tab=sold");
  const [canManage, settings, prop] = await Promise.all([
    isOwnerOrSuper(request, propertyId),
    getSettings(propertyId),
    getProperty(propertyId),
  ]);

  const now = Date.now();
  // Activity timeline, newest last. Bookings are resolved to references so
  // gift spends and package redemptions link straight into the booking page.
  const activity = await Promise.all(
    v.redemptions.map(async (r) => {
      const booking = r.bookingId ? await getBooking(propertyId, r.bookingId).catch(() => null) : null;
      const liveHold = Boolean(r.pendingUntil && !r.bookingId && Date.parse(r.pendingUntil) > now);
      return {
        at: r.at,
        amount: r.amount,
        by: r.by,
        note: r.note,
        bookingId: r.bookingId,
        bookingRef: booking?.reference,
        liveHold,
        expiredHold: Boolean(r.pendingUntil && !r.bookingId && Date.parse(r.pendingUntil) <= now),
      };
    }),
  );

  return {
    currency: settings.currency || "GBP",
    canManage,
    guestUrl: `/${prop?.slug || propertyId}/voucher/${v.code}`,
    voucher: {
      code: v.code,
      kind: v.kind,
      status: displayStatus(v, now),
      /** Stored status (ignores expiry) — an expired-but-active voucher can
       *  still have its terms edited, which is exactly how it gets revived. */
      storedActive: v.status === "active",
      comp: v.comp ?? false,
      simulated: v.simulated ?? false,
      purchasedAt: v.purchasedAt,
      expiresAt: v.expiresAt,
      buyer: v.buyer,
      gift: v.gift,
      balance: v.kind === "gift" ? (v.balance ?? 0) : undefined,
      spendable: v.kind === "gift" ? giftBalance(v, now) : undefined,
      payment: v.payment
        ? {
            amount: v.payment.amount,
            currency: v.payment.currency,
            hasCharge: Boolean(v.payment.paymentIntentId),
            refund: v.payment.refund ?? null,
          }
        : null,
      product: {
        title: v.product.title,
        description: v.product.description,
        price: v.product.price,
        value: v.product.value,
        guests: v.product.guests,
        terms: v.product.terms,
        included: v.product.included ?? [],
        roomTitles: v.product.roomTitles ?? [],
        package: v.product.package
          ? {
              nights: v.product.package.nights,
              adults: v.product.package.adults,
              children: v.product.package.children,
              checkinDays: v.product.package.checkinDays,
              window: v.product.package.window,
              blockedRanges: v.product.package.blockedRanges,
            }
          : null,
      },
      activity,
      edits: v.edits ?? [],
    },
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return { error: "No property selected." };
  const code = normalizeVoucherCode(params.code);
  const v = await getVoucherByCode(propertyId, code);
  if (!v) return { error: "Voucher not found." };

  const form = await request.formData();
  const intent = form.get("intent");
  const ownerGate = async () =>
    (await isOwnerOrSuper(request, propertyId)) ? null : { error: "Only an owner or manager can do that." };

  if (intent === "resend") {
    const prop = await getProperty(propertyId);
    await sendVoucherEmails(propertyId, v, new URL(request.url).origin, prop?.slug || propertyId);
    const to = [v.buyer.email, v.gift?.recipientEmail].filter(Boolean).join(" and ");
    return { resent: to };
  }

  if (intent === "markRedeemed") {
    const gate = await ownerGate();
    if (gate) return gate;
    const by = (await getAdminEmail(request)) ?? "admin";
    if (!(await manualRedeemVoucher(propertyId, code, by))) {
      return { error: "Only an active package or experience voucher can be marked redeemed." };
    }
    return { redeemed: true as const };
  }

  if (intent === "deduct") {
    const gate = await ownerGate();
    if (gate) return gate;
    const amount = Math.round(Number(String(form.get("amount") ?? "")) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) return { error: "Enter the amount to deduct." };
    const by = (await getAdminEmail(request)) ?? "admin";
    if (!(await deductGift(propertyId, code, amount, by))) {
      return { error: "Couldn't deduct — check the voucher is active and has enough balance." };
    }
    return { deducted: true as const };
  }

  if (intent === "cancel") {
    const gate = await ownerGate();
    if (gate) return gate;
    if (!(await cancelVoucher(propertyId, code))) return { error: "Only an active voucher can be cancelled." };
    return { cancelled: true as const };
  }

  if (intent === "editTerms") {
    const gate = await ownerGate();
    if (gate) return gate;
    const ISO = /^\d{4}-\d{2}-\d{2}$/;
    const expires = String(form.get("expires") ?? "").trim();
    if (!ISO.test(expires)) return { error: "Pick a valid expiry date." };

    let window: { from?: string; to?: string } | undefined;
    let blockedRanges: { from: string; to: string }[] | undefined;
    if (v.product.package) {
      const from = String(form.get("windowFrom") ?? "").trim();
      const to = String(form.get("windowTo") ?? "").trim();
      if (from && !ISO.test(from)) return { error: "The stay window 'from' date is invalid." };
      if (to && !ISO.test(to)) return { error: "The stay window 'to' date is invalid." };
      if (from && to && from > to) return { error: "The stay window ends before it starts." };
      window = { from: from || undefined, to: to || undefined };
      const parsed = parseBlockedRanges(String(form.get("blockedRanges") ?? ""));
      if ("bad" in parsed) return { error: `Can't read blocked date line: "${parsed.bad}" — use YYYY-MM-DD..YYYY-MM-DD.` };
      blockedRanges = parsed.ranges;
    }

    const by = (await getAdminEmail(request)) ?? "admin";
    // End-of-day expiry so "valid until 31 Jan" includes the 31st.
    const r = await updateVoucherTerms(propertyId, code, { expiresAt: `${expires}T23:59:59.000Z`, window, blockedRanges }, by);
    if (!r.ok) return { error: "Nothing changed — or the voucher is redeemed/cancelled." };
    return { termsUpdated: r.changed };
  }

  if (intent === "refund") {
    const gate = await ownerGate();
    if (gate) return gate;
    const by = (await getAdminEmail(request)) ?? "admin";
    const r = await refundVoucherCharge(propertyId, v, by);
    if (r.ok) return { refunded: r.amount };
    return {
      error:
        r.reason === "already_refunded"
          ? "This voucher has already been refunded."
          : r.reason === "no_charge"
            ? "There's no Stripe charge on this voucher to refund."
            : "The refund couldn't be processed — check Stripe and try again.",
    };
  }

  return { error: "Unknown action." };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData ? `Admin · Voucher ${loaderData.voucher.code}` : "Admin · Voucher" }];
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5">
      <span className="text-[13px] text-muted-2">{label}</span>
      <span className="text-right text-[14px] font-medium text-ink">{value}</span>
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  active: "bg-[#e8f0e6] text-[#3f7a52]",
  redeemed: "bg-chip text-muted",
  cancelled: "bg-[#fbe9e7] text-[#c0392b]",
  expired: "bg-[#fbe9e7] text-[#c0392b]",
};

const KIND_LABEL: Record<string, string> = {
  gift: "Gift voucher",
  package: "Stay package",
  experience: "Experience",
};

export default function AdminVoucher({ loaderData, actionData }: Route.ComponentProps) {
  const { voucher: v, currency, canManage, guestUrl } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const money = (n: number) => formatMoney(n, currency);
  const dt = (iso: string) => fmtDate(iso, "d MMM yyyy, HH:mm");
  const d = (iso: string) => fmtDate(iso, "d MMM yyyy");
  const section = "rounded-[14px] border border-line bg-surface p-5";
  const actionBtn =
    "rounded-[10px] border border-line-alt px-4 py-2.5 text-[13.5px] font-semibold text-secondary hover:bg-chip disabled:opacity-60";
  const active = v.status === "active";
  const pkg = v.product.package;

  return (
    <div>
      <Link
        to="/admin/vouchers?tab=sold"
        className="mb-4 inline-block text-[13px] font-semibold text-muted hover:text-accent"
      >
        ← Sold vouchers
      </Link>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-[26px] font-semibold">
          {v.product.title} <span className="ml-1 font-mono text-[15px] font-semibold text-accent-deep">{v.code}</span>
        </h1>
        <div className="flex items-center gap-2">
          {v.simulated && (
            <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11.5px] font-semibold text-amber-800">test</span>
          )}
          {v.comp && (
            <span className="rounded-full bg-chip px-2.5 py-1 text-[11.5px] font-semibold text-muted">comp</span>
          )}
          <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${STATUS_STYLE[v.status] ?? "bg-chip text-muted"}`}>
            {v.status}
          </span>
        </div>
      </div>

      {actionData && "error" in actionData && actionData.error && (
        <div className="mb-5 rounded-[12px] border border-[#f3d0ca] bg-[#fbe9e7] px-4 py-3 text-[13.5px] text-[#c0392b]">
          {actionData.error}
        </div>
      )}
      {actionData && "resent" in actionData && (
        <div className="mb-5 rounded-[12px] border border-[#cfe3d0] bg-[#eef5ec] px-4 py-3 text-[13.5px] font-medium text-[#3f7a52]">
          ✓ Voucher email re-sent to {actionData.resent}.
        </div>
      )}
      {actionData && "redeemed" in actionData && (
        <div className="mb-5 rounded-[12px] border border-[#cfe3d0] bg-[#eef5ec] px-4 py-3 text-[13.5px] font-medium text-[#3f7a52]">
          ✓ Marked as redeemed.
        </div>
      )}
      {actionData && "deducted" in actionData && (
        <div className="mb-5 rounded-[12px] border border-[#cfe3d0] bg-[#eef5ec] px-4 py-3 text-[13.5px] font-medium text-[#3f7a52]">
          ✓ Amount deducted from the balance.
        </div>
      )}
      {actionData && "cancelled" in actionData && (
        <div className="mb-5 rounded-[12px] border border-[#f3d0ca] bg-[#fbe9e7] px-4 py-3 text-[13.5px] font-medium text-[#c0392b]">
          Voucher cancelled. Refund the payment below if one was taken.
        </div>
      )}
      {actionData && "termsUpdated" in actionData && (
        <div className="mb-5 rounded-[12px] border border-[#cfe3d0] bg-[#eef5ec] px-4 py-3 text-[13.5px] font-medium text-[#3f7a52]">
          ✓ Redemption terms updated — the change applies to this voucher immediately.
        </div>
      )}
      {actionData && "refunded" in actionData && typeof actionData.refunded === "number" && (
        <div className="mb-5 rounded-[12px] border border-[#cfe3d0] bg-[#eef5ec] px-4 py-3 text-[13.5px] font-medium text-[#3f7a52]">
          ✓ {money(actionData.refunded)} refunded to the buyer's payment method.
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Voucher */}
        <section className={section}>
          <h2 className="mb-3 font-serif text-[18px] font-semibold">Voucher</h2>
          <Row label="Type" value={KIND_LABEL[v.kind] ?? v.kind} />
          <Row label="Sale price" value={money(v.product.price)} />
          {v.kind === "gift" && (
            <>
              <Row label="Face value" value={money(v.product.value ?? v.product.price)} />
              <Row label="Stored balance" value={money(v.balance ?? 0)} />
              {v.spendable !== v.balance && <Row label="Spendable now (after holds)" value={money(v.spendable ?? 0)} />}
            </>
          )}
          {v.kind === "experience" && v.product.guests != null && (
            <Row label="Guests" value={String(v.product.guests)} />
          )}
          {pkg && (
            <>
              <Row
                label="Stay"
                value={`${pkg.nights} night${pkg.nights === 1 ? "" : "s"} · ${pkg.adults} adult${pkg.adults === 1 ? "" : "s"}${pkg.children ? ` + ${pkg.children} child${pkg.children === 1 ? "" : "ren"}` : ""}`}
              />
              {v.product.roomTitles.length > 0 && <Row label="Rooms" value={v.product.roomTitles.join(" · ")} />}
              <Row
                label="Check-in days"
                value={pkg.checkinDays.length ? pkg.checkinDays.map((x) => WEEKDAY_LABELS[x]).join(" / ") : "Any day"}
              />
              {(pkg.window?.from || pkg.window?.to) && (
                <Row label="Stay window" value={`${pkg.window.from ?? "…"} – ${pkg.window.to ?? "…"}`} />
              )}
              {pkg.blockedRanges.length > 0 && (
                <Row
                  label="Blocked dates"
                  value={pkg.blockedRanges.map((r) => (r.from === r.to ? r.from : `${r.from}..${r.to}`)).join(", ")}
                />
              )}
            </>
          )}
          <Row label="Purchased" value={dt(v.purchasedAt)} />
          <Row label="Expires" value={d(v.expiresAt)} />
          {v.product.terms && <Row label="Terms" value={v.product.terms} />}
          <div className="mt-3 border-t border-divider pt-3 text-[13px]">
            <a href={guestUrl} target="_blank" rel="noreferrer" className="font-semibold text-accent hover:text-accent-deep">
              Open the guest voucher page ↗
            </a>
          </div>
        </section>

        {/* Buyer & recipient */}
        <section className={section}>
          <h2 className="mb-3 font-serif text-[18px] font-semibold">Buyer & recipient</h2>
          <Row label="Buyer" value={v.buyer.name} />
          <Row label="Buyer email" value={v.buyer.email} />
          {v.gift && (
            <>
              <Row label="Recipient" value={v.gift.recipientName} />
              <Row label="Recipient email" value={v.gift.recipientEmail ?? "— (buyer hands it over)"} />
              {v.gift.message && <Row label="Gift message" value={`“${v.gift.message}”`} />}
            </>
          )}

          <h2 className="mb-3 mt-6 font-serif text-[18px] font-semibold">Payment</h2>
          {v.payment ? (
            <>
              <Row label="Paid" value={money(v.payment.amount ?? v.product.price)} />
              {v.payment.refund ? (
                <Row
                  label="Refunded"
                  value={`${money(v.payment.refund.amount)} on ${d(v.payment.refund.at)}${v.payment.refund.by ? ` by ${v.payment.refund.by}` : ""}`}
                />
              ) : (
                v.payment.hasCharge &&
                canManage && (
                  <Form
                    method="post"
                    onSubmit={(e) => {
                      if (!confirm(`Refund ${money(v.payment!.amount ?? v.product.price)} to the buyer's original payment method?`)) e.preventDefault();
                    }}
                    className="mt-2"
                  >
                    <input type="hidden" name="intent" value="refund" />
                    <button type="submit" disabled={busy} className={actionBtn}>
                      Refund {money(v.payment.amount ?? v.product.price)}
                    </button>
                  </Form>
                )
              )}
            </>
          ) : (
            <p className="m-0 text-[13.5px] text-muted">
              {v.comp ? "Complimentary — no payment taken." : "Test purchase — no payment taken."}
            </p>
          )}
        </section>
      </div>

      {/* Activity */}
      <section className={`${section} mt-5`}>
        <h2 className="mb-3 font-serif text-[18px] font-semibold">Activity</h2>
        {v.activity.length === 0 ? (
          <p className="m-0 text-[13.5px] text-muted">No redemptions yet.</p>
        ) : (
          <div className="flex flex-col">
            {v.activity.map((a, i) => (
              <div key={i} className={`flex flex-wrap items-baseline justify-between gap-2 py-2 ${i > 0 ? "border-t border-divider" : ""}`}>
                <span className="text-[14px] text-ink">
                  {a.note === "cooling-off cancel"
                    ? `Cancelled by the buyer (cooling-off)${a.by ? ` — ${a.by}` : ""}`
                    : a.note === "manual" && a.amount == null
                      ? `Marked redeemed${a.by ? ` by ${a.by}` : ""}`
                      : a.liveHold
                        ? `${a.amount != null ? money(a.amount) : ""} held by a checkout in progress`
                        : a.expiredHold
                          ? `${a.amount != null ? money(a.amount) : ""} hold expired (checkout abandoned)`
                          : a.bookingRef
                            ? (
                                <>
                                  {a.amount != null ? `${money(a.amount)} spent on ` : "Redeemed against "}
                                  <Link to={`/admin/bookings/${a.bookingId}`} className="font-semibold text-accent hover:text-accent-deep">
                                    booking {a.bookingRef}
                                  </Link>
                                </>
                              )
                            : `${a.amount != null ? `${money(a.amount)} deducted` : "Redeemed"}${a.by ? ` by ${a.by}` : ""}`}
                </span>
                <span className="text-[12.5px] text-muted-2">{dt(a.at)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Redemption terms — the deliberate way to amend a sold voucher */}
      {canManage && v.storedActive && (
        <section className={`${section} mt-5`}>
          <h2 className="mb-1 font-serif text-[18px] font-semibold">Redemption terms</h2>
          <p className="mb-4 mt-0 text-[13px] leading-[1.55] text-secondary">
            Sold vouchers keep the terms they were bought with — catalog edits never touch them. Amend this
            voucher here instead: extend the expiry (an expired voucher becomes usable again), widen the stay
            window, or add a blocked date you forgot. Every change is logged below
            {v.gift ? " — resend the voucher email afterwards so the recipient sees the new dates" : ""}.
          </p>
          <Form method="post" className="flex flex-col gap-4">
            <input type="hidden" name="intent" value="editTerms" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <label className="block text-[13px] font-semibold text-secondary">
                Expires
                <input name="expires" type="date" defaultValue={v.expiresAt.slice(0, 10)} className={FIELD_INPUT} />
              </label>
              {pkg && (
                <>
                  <label className="block text-[13px] font-semibold text-secondary">
                    Stay window from <span className="font-normal text-faint">(blank = open)</span>
                    <input name="windowFrom" type="date" defaultValue={pkg.window?.from ?? ""} className={FIELD_INPUT} />
                  </label>
                  <label className="block text-[13px] font-semibold text-secondary">
                    Stay window to <span className="font-normal text-faint">(blank = open)</span>
                    <input name="windowTo" type="date" defaultValue={pkg.window?.to ?? ""} className={FIELD_INPUT} />
                  </label>
                </>
              )}
            </div>
            {pkg && (
              <div className="block text-[13px] font-semibold text-secondary">
                Blocked dates
                <BlockedRangesEditor
                  key={blockedRangesToText(pkg.blockedRanges)}
                  name="blockedRanges"
                  initial={pkg.blockedRanges}
                />
              </div>
            )}
            <div>
              <button type="submit" disabled={busy} className={actionBtn}>
                Save terms
              </button>
            </div>
          </Form>
          {v.edits.length > 0 && (
            <div className="mt-4 border-t border-divider pt-3">
              <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-2">Edit history</div>
              {v.edits.map((e, i) => (
                <div key={i} className="py-1 text-[13px] text-secondary">
                  <span className="text-muted-2">{dt(e.at)}</span>
                  {e.by ? ` · ${e.by}` : ""} —{" "}
                  {e.changes.map((c) => `${c.field}: ${c.from} → ${c.to}`).join("; ")}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Actions */}
      <section className={`${section} mt-5`}>
        <h2 className="mb-3 font-serif text-[18px] font-semibold">Actions</h2>
        <div className="flex flex-wrap items-center gap-3">
          <Form method="post">
            <input type="hidden" name="intent" value="resend" />
            <button type="submit" disabled={busy} className={actionBtn}>
              Resend voucher email
            </button>
          </Form>

          {active && v.kind !== "gift" && canManage && (
            <Form
              method="post"
              onSubmit={(e) => {
                if (!confirm(v.kind === "package" ? "Mark this package voucher as redeemed (booked by phone/at the desk)?" : "Mark this experience voucher as redeemed (the guest used it)?")) e.preventDefault();
              }}
            >
              <input type="hidden" name="intent" value="markRedeemed" />
              <button type="submit" disabled={busy} className={actionBtn}>
                Mark redeemed
              </button>
            </Form>
          )}

          {active && v.kind === "gift" && canManage && (
            <Form method="post" className="flex items-center gap-2">
              <input type="hidden" name="intent" value="deduct" />
              <input
                name="amount"
                type="number"
                min={0.01}
                step="0.01"
                placeholder="0.00"
                className="w-[92px] rounded-[10px] border border-line-alt bg-surface px-2.5 py-2 text-[13.5px] outline-none focus:border-accent"
              />
              <button type="submit" disabled={busy} className={actionBtn}>
                Deduct from balance
              </button>
            </Form>
          )}

          {active && canManage && (
            <Form
              method="post"
              onSubmit={(e) => {
                if (!confirm("Cancel this voucher? It can no longer be used.")) e.preventDefault();
              }}
            >
              <input type="hidden" name="intent" value="cancel" />
              <button
                type="submit"
                disabled={busy}
                className="rounded-[10px] border border-[#e5c4bd] px-4 py-2.5 text-[13.5px] font-semibold text-[#c0392b] hover:bg-[#fbe9e7] disabled:opacity-60"
              >
                Cancel voucher
              </button>
            </Form>
          )}
        </div>
        {!canManage && (
          <p className="mb-0 mt-3 text-[12.5px] text-faint">
            Redeeming, deducting, cancelling and refunding are limited to owners and managers.
          </p>
        )}
      </section>
    </div>
  );
}
