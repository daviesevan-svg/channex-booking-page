// Voucher product detail + purchase. Live sales go through Stripe Checkout
// (pending stash → hosted payment → finalize on return/webhook, exactly like
// bookings); test mode issues a simulated voucher directly.
import { useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/voucher-buy";
import { useProperty } from "~/lib/booking-context";
import { useT } from "~/lib/i18n";
import { formatMoney } from "~/lib/money";
import { getConfig } from "~/lib/config.server";
import { resolvePropertyId } from "~/lib/properties.server";
import { getOverrides, getSettings } from "~/lib/overrides.server";
import { getRooms } from "~/lib/catalog.server";
import { computeExpiry, voucherCode, WEEKDAY_LABELS, type VoucherRecord } from "~/lib/vouchers";
import { getVoucherProduct, soldCount } from "~/lib/vouchers.server";
import { generateReference } from "~/lib/bookings.server";
import { stashPendingVoucher, type PendingVoucher } from "~/lib/pending-vouchers.server";
import { finalizeVoucher } from "~/lib/voucher-purchase.server";
import { createCheckoutSession } from "~/lib/stripe.server";

export async function loader({ params }: Route.LoaderArgs) {
  const pid = await resolvePropertyId(params.channelId);
  const product = await getVoucherProduct(pid, params.productId);
  if (!product || !product.active) throw redirect(`/${params.channelId}/vouchers`);
  const soldOut = product.cap != null && (await soldCount(pid, product.id).catch(() => 0)) >= product.cap;
  // Room names for the package summary (public info).
  let roomTitles: string[] = [];
  if (product.package) {
    const rooms = await getRooms(pid).catch(() => []);
    roomTitles = product.package.roomIds
      .map((id) => rooms.find((r) => r.id === id)?.title)
      .filter((t): t is string => Boolean(t));
  }
  // Strict public projection (loader data serializes into the HTML).
  return {
    product: {
      id: product.id,
      kind: product.kind,
      title: product.title,
      description: product.description,
      image: product.image,
      price: product.price,
      value: product.kind === "gift" ? (product.value ?? product.price) : undefined,
      expiresMonths: product.expiresMonths,
      terms: product.terms,
      package: product.package
        ? {
            nights: product.package.nights,
            adults: product.package.adults,
            children: product.package.children,
            checkinDays: product.package.checkinDays,
            window: product.package.window,
          }
        : undefined,
      roomTitles,
    },
    soldOut,
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const pid = await resolvePropertyId(params.channelId);
  const product = await getVoucherProduct(pid, params.productId);
  if (!product || !product.active) return { error: "This voucher is no longer on sale." };
  if (product.cap != null && (await soldCount(pid, product.id)) >= product.cap) {
    return { error: "Sold out — this voucher is no longer available." };
  }

  const form = await request.formData();
  const buyerName = String(form.get("buyerName") ?? "").trim();
  const buyerEmail = String(form.get("buyerEmail") ?? "").trim();
  const isGift = form.get("isGift") != null;
  const recipientName = String(form.get("recipientName") ?? "").trim();
  const recipientEmail = String(form.get("recipientEmail") ?? "").trim();
  const message = String(form.get("message") ?? "").trim();

  if (!buyerName) return { error: "Enter your name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) return { error: "Enter a valid email address." };
  if (isGift && !recipientName) return { error: "Enter the recipient's name." };
  if (isGift && recipientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
    return { error: "The recipient's email doesn't look valid." };
  }
  if (product.terms && form.get("agree") == null) return { error: "Please agree to the voucher terms." };

  const [settings, config] = [await getSettings(pid), getConfig()];
  const live = Boolean(settings.liveBooking ?? config.allowLiveBooking);
  const stripeAccount = settings.stripeAccountId as string | undefined;
  if (live && !stripeAccount) {
    return { error: "Online payment isn't set up for this property yet — vouchers can't be sold." };
  }

  // Room names frozen into the snapshot for display on the voucher/PDF.
  let roomTitles: string[] | undefined;
  if (product.package) {
    const rooms = await getRooms(pid).catch(() => []);
    roomTitles = product.package.roomIds
      .map((id) => rooms.find((r) => r.id === id)?.title)
      .filter((t): t is string => Boolean(t));
  }

  const now = new Date().toISOString();
  const record: Omit<VoucherRecord, "payment"> = {
    id: crypto.randomUUID(),
    code: voucherCode(),
    kind: product.kind,
    productId: product.id,
    product: {
      title: product.title,
      description: product.description,
      image: product.image,
      price: product.price,
      value: product.kind === "gift" ? (product.value ?? product.price) : undefined,
      terms: product.terms,
      package: product.package,
      roomTitles,
    },
    buyer: { name: buyerName, email: buyerEmail },
    gift: isGift ? { recipientName, recipientEmail: recipientEmail || undefined, message: message || undefined } : undefined,
    purchasedAt: now,
    expiresAt: computeExpiry(now, product.expiresMonths),
    status: "active",
    balance: product.kind === "gift" ? (product.value ?? product.price) : undefined,
    redemptions: [],
  };

  const url = new URL(request.url);
  const pending: PendingVoucher = {
    pid,
    account: stripeAccount ?? "",
    record,
    live,
    channel: params.channelId,
    origin: url.origin,
  };

  if (!live) {
    // Test mode: issue a simulated voucher directly — same as simulated bookings.
    const issued = await finalizeVoucher(pending, undefined);
    return redirect(`/${params.channelId}/voucher/${issued.code}?issued=1`);
  }

  const reference = generateReference();
  await stashPendingVoucher(reference, pending);
  const currency = settings.currency || "GBP";
  const amountMinor = Math.round(product.price * 100);
  const feeBps = config.stripePlatformFeeBps;
  const hotelName = (await getOverrides(pid)).hotelName || "Your hotel";
  let sessionUrl: string | undefined;
  try {
    const session = await createCheckoutSession(
      stripeAccount!,
      {
        client_reference_id: reference,
        customer_email: buyerEmail,
        metadata: { kind: "voucher", reference, pid },
        // Same 60-min payment window inside the 3h pending stash as bookings.
        expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
        success_url: `${url.origin}/${params.channelId}/vouchers/complete?session_id={CHECKOUT_SESSION_ID}&ref=${reference}`,
        cancel_url: `${url.origin}/${params.channelId}/vouchers/${product.id}`,
        mode: "payment",
        payment_intent_data: {
          description: `${hotelName} voucher · ${product.title} (${record.code})`,
          metadata: { kind: "voucher", reference, pid },
          ...(feeBps > 0 ? { application_fee_amount: Math.round((amountMinor * feeBps) / 10000) } : {}),
        },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: currency.toLowerCase(),
              unit_amount: amountMinor,
              product_data: {
                name: `${hotelName} — ${product.title}`,
                description:
                  product.kind === "gift"
                    ? `Gift voucher worth ${formatMoney(product.value ?? product.price, currency)}.`
                    : product.description || "Stay package voucher.",
              },
            },
          },
        ],
      },
      reference,
    );
    sessionUrl = session.url;
  } catch (e) {
    console.log(`[vouchers] stripe session failed for pid=${pid}: ${e instanceof Error ? e.message : e}`);
    return { error: "The payment couldn't be started — please try again." };
  }
  if (!sessionUrl) return { error: "The payment couldn't be started — please try again." };
  throw redirect(sessionUrl);
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData?.product.title ?? "Voucher" }];
}

export default function VoucherBuy({ loaderData, actionData, params }: Route.ComponentProps) {
  const { product: p, soldOut } = loaderData;
  const { currency } = useProperty();
  const tr = useT();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const [isGift, setIsGift] = useState(false);
  const money = (n: number) => formatMoney(n, currency);
  const stripe = "repeating-linear-gradient(135deg,#efe7da,#efe7da 12px,#e7ddcc 12px,#e7ddcc 24px)";
  const input =
    "mt-1.5 block w-full rounded-[10px] border border-line-alt bg-surface px-3.5 py-2.5 text-[15px] text-ink outline-none focus:border-accent";

  return (
    <main className="mx-auto max-w-[1160px] px-7 pb-[72px] pt-7">
      <Link
        to={`/${params.channelId}/vouchers`}
        className="mb-5 inline-block text-sm font-semibold text-muted hover:text-accent"
      >
        ← {tr.t("vouchersTitle")}
      </Link>

      <div className="flex flex-wrap items-start gap-10">
        <div className="min-w-[320px] flex-[1.4]">
          <div className="mb-6 h-[280px] overflow-hidden rounded-[16px]" style={{ background: stripe }}>
            {p.image && <img src={p.image} alt={p.title} className="h-full w-full object-cover" />}
          </div>
          <span className="rounded-full bg-chip px-2.5 py-1 text-[11.5px] font-semibold text-muted">
            {p.kind === "gift" ? tr.t("voucherKindGift") : tr.t("voucherKindPackage")}
          </span>
          <h1 className="mb-2 mt-2 font-serif text-[36px] font-medium tracking-[-0.02em]">{p.title}</h1>
          {p.description && <p className="mb-5 max-w-[560px] text-[16px] leading-[1.65] text-secondary">{p.description}</p>}

          {p.kind === "package" && p.package && (
            <div className="mb-5 rounded-[14px] border border-line bg-surface p-5 text-[14px] leading-[1.7] text-secondary">
              <div className="font-semibold text-ink">
                {tr.p("night", p.package.nights)} · {tr.p("adult", p.package.adults)}
                {p.package.children ? ` + ${tr.p("child", p.package.children)}` : ""}
              </div>
              {p.roomTitles.length > 0 && <div>{p.roomTitles.join(" · ")}</div>}
              {p.package.checkinDays.length > 0 && (
                <div>{tr.t("voucherCheckinDays", { days: p.package.checkinDays.map((d) => WEEKDAY_LABELS[d]).join(" / ") })}</div>
              )}
              {(p.package.window?.from || p.package.window?.to) && (
                <div>{tr.t("voucherStayWindow", { from: p.package.window.from ?? "…", to: p.package.window.to ?? "…" })}</div>
              )}
              <div className="mt-1.5 text-[13px] text-muted">{tr.t("voucherBookOnlineNote")}</div>
            </div>
          )}
          {p.kind === "gift" && (
            <p className="mb-5 text-[15px] font-semibold text-accent-deep">
              {tr.t("voucherValue", { amount: money(p.value ?? p.price) })}
            </p>
          )}
          <p className="text-[13px] text-muted">{tr.t("voucherValidFor", { n: String(p.expiresMonths) })}</p>
          {p.terms && (
            <div className="mt-4 max-w-[560px] text-[12.5px] leading-[1.6] text-muted">
              <span className="font-semibold">{tr.t("voucherTermsTitle")}:</span> {p.terms}
            </div>
          )}
        </div>

        <div className="min-w-[320px] max-w-[420px] flex-1">
          <div className="rounded-[16px] border border-line bg-surface p-6" style={{ boxShadow: "var(--shadow-card)" }}>
            {soldOut ? (
              <p className="text-[15px] font-semibold text-[#c0392b]">{tr.t("voucherSoldOut")}</p>
            ) : (
              <Form method="post" className="flex flex-col gap-4">
                <h2 className="font-serif text-[20px] font-semibold">{tr.t("voucherYourDetails")}</h2>
                <label className="block text-[13px] font-semibold text-secondary">
                  {tr.t("buyerName")}
                  <input name="buyerName" required className={input} />
                </label>
                <label className="block text-[13px] font-semibold text-secondary">
                  {tr.t("buyerEmail")}
                  <input name="buyerEmail" type="email" required className={input} />
                </label>

                <label className="flex items-center gap-2.5 text-[14px] font-semibold">
                  <input
                    type="checkbox"
                    name="isGift"
                    checked={isGift}
                    onChange={(e) => setIsGift(e.target.checked)}
                    className="h-4 w-4 rounded border-line-alt text-accent focus:ring-accent"
                  />
                  {tr.t("voucherIsGift")}
                </label>
                {isGift && (
                  <>
                    <label className="block text-[13px] font-semibold text-secondary">
                      {tr.t("recipientName")}
                      <input name="recipientName" className={input} />
                    </label>
                    <label className="block text-[13px] font-semibold text-secondary">
                      {tr.t("recipientEmail")}
                      <input name="recipientEmail" type="email" className={input} />
                      <span className="mt-1 block text-[11.5px] font-normal text-faint">{tr.t("recipientEmailHint")}</span>
                    </label>
                    <label className="block text-[13px] font-semibold text-secondary">
                      {tr.t("giftMessage")}
                      <textarea name="message" rows={2} maxLength={400} className={`${input} resize-y`} />
                    </label>
                  </>
                )}

                {p.terms && (
                  <label className="flex items-start gap-2.5 text-[13px] text-secondary">
                    <input type="checkbox" name="agree" className="mt-0.5 h-4 w-4 rounded border-line-alt text-accent focus:ring-accent" />
                    {tr.t("voucherAgreeTerms")}
                  </label>
                )}

                {actionData?.error && <p className="text-[13px] text-red-600">{actionData.error}</p>}
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-[12px] bg-accent px-6 py-3.5 text-[16px] font-semibold text-white hover:bg-accent-deep disabled:opacity-60"
                >
                  {busy ? "…" : tr.t("voucherBuy", { amount: money(p.price) })}
                </button>
              </Form>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
