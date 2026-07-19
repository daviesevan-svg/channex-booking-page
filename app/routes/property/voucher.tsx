// The voucher itself — the page behind the emailed link/PDF. The unguessable
// code is the credential (like review/booking links). Shows status, value or
// package summary, expiry, PDF download, and the redemption CTA.
import { Link } from "react-router";

import type { Route } from "./+types/voucher";
import { useProperty } from "~/lib/booking-context";
import { useT } from "~/lib/i18n";
import { formatMoney } from "~/lib/money";
import { fmtDate } from "~/lib/dates";
import { resolvePropertyId } from "~/lib/properties.server";
import { getVoucherByCode } from "~/lib/vouchers.server";
import { getBooking } from "~/lib/bookings.server";
import { displayStatus, giftBalance, normalizeVoucherCode, WEEKDAY_LABELS } from "~/lib/vouchers";

export async function loader({ params, request }: Route.LoaderArgs) {
  const pid = await resolvePropertyId(params.channelId);
  const v = await getVoucherByCode(pid, normalizeVoucherCode(params.code));
  if (!v) throw new Response("Voucher not found", { status: 404 });
  const issued = new URL(request.url).searchParams.get("issued") === "1";
  const justBooked = new URL(request.url).searchParams.get("booked") === "1";
  // A redeemed package links its booking — show the stay (public projection).
  const bookingId = v.redemptions.find((r) => r.bookingId)?.bookingId;
  const booking = v.kind === "package" && bookingId ? await getBooking(pid, bookingId).catch(() => null) : null;
  // Strict public projection — no buyer email, no payment ids (the code holder
  // sees names/message, which is the point of a gift).
  return {
    issued,
    justBooked,
    booking:
      booking && (booking.lifecycle ?? "active") === "active"
        ? {
            reference: booking.reference,
            checkin: booking.checkin,
            checkout: booking.checkout,
            roomTitle: booking.rooms[0]?.roomTitle ?? "",
            guestName: `${booking.guest.firstName} ${booking.guest.lastName}`,
          }
        : null,
    voucher: {
      code: v.code,
      kind: v.kind,
      status: displayStatus(v),
      expiresAt: v.expiresAt,
      balance: v.kind === "gift" ? giftBalance(v) : undefined,
      simulated: v.simulated ?? false,
      buyerName: v.buyer.name,
      gift: v.gift ? { recipientName: v.gift.recipientName, message: v.gift.message } : undefined,
      product: {
        title: v.product.title,
        description: v.product.description,
        image: v.product.image,
        price: v.product.price,
        value: v.product.value,
        terms: v.product.terms,
        roomTitles: v.product.roomTitles ?? [],
        package: v.product.package
          ? {
              nights: v.product.package.nights,
              adults: v.product.package.adults,
              children: v.product.package.children,
              checkinDays: v.product.package.checkinDays,
              window: v.product.package.window,
            }
          : undefined,
      },
    },
  };
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

export default function Voucher({ loaderData, params }: Route.ComponentProps) {
  const { voucher: v, issued, justBooked, booking } = loaderData;
  const { currency, hotelName } = useProperty();
  const tr = useT();
  const money = (n: number) => formatMoney(n, currency);
  const statusLabel = tr.t(`voucherStatus_${v.status}`);
  const stripe = "repeating-linear-gradient(135deg,#efe7da,#efe7da 12px,#e7ddcc 12px,#e7ddcc 24px)";

  return (
    <main className="mx-auto max-w-[720px] px-7 pb-[72px] pt-10">
      {issued && (
        <div className="mb-6 rounded-[12px] border border-[#cfe3d0] bg-[#eef5ec] px-4 py-3 text-[14px] font-medium text-[#3f7a52]">
          ✓ {tr.t("voucherIssued")}
        </div>
      )}
      {v.simulated && (
        <div className="mb-6 rounded-[12px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900">
          Test voucher — no payment was taken.
        </div>
      )}
      {booking && (
        <div
          className={`mb-6 rounded-[12px] border border-[#cfe3d0] bg-[#eef5ec] px-4 py-3.5 text-[14px] leading-[1.6] text-[#3f7a52]`}
        >
          {justBooked && <div className="font-semibold">✓ {tr.t("bookingConfirmedTitle")}</div>}
          <div>
            {booking.guestName} · {booking.roomTitle} · {fmtDate(booking.checkin, "EEE d MMM")} —{" "}
            {fmtDate(booking.checkout, "EEE d MMM yyyy")} ·{" "}
            <span className="font-mono font-semibold">{booking.reference}</span>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-[18px] border border-line bg-surface" style={{ boxShadow: "var(--shadow-card)" }}>
        <div className="h-[190px] overflow-hidden" style={{ background: stripe }}>
          {v.product.image && <img src={v.product.image} alt="" className="h-full w-full object-cover" />}
        </div>
        <div className="p-7">
          <div className="mb-2 flex flex-wrap items-center gap-2.5">
            <span className="rounded-full bg-chip px-2.5 py-0.5 text-[11.5px] font-semibold text-muted">
              {v.kind === "gift" ? tr.t("voucherKindGift") : tr.t("voucherKindPackage")}
            </span>
            <span className={`rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold ${STATUS_STYLE[v.status]}`}>
              {statusLabel}
            </span>
          </div>
          <h1 className="mb-1 font-serif text-[30px] font-medium tracking-[-0.01em]">{v.product.title}</h1>
          <p className="mb-5 text-[14px] text-muted">{hotelName}</p>

          {v.gift && (
            <div className="mb-5 rounded-[12px] bg-surface-alt px-4 py-3 text-[14px] leading-[1.6] text-secondary">
              <div className="font-semibold">{tr.t("voucherGiftFor", { name: v.gift.recipientName, from: v.buyerName })}</div>
              {v.gift.message && <p className="mt-1 italic">“{v.gift.message}”</p>}
            </div>
          )}

          {/* the code */}
          <div className="mb-5 rounded-[14px] border-2 border-dashed border-accent bg-accent-soft/40 px-5 py-4 text-center">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-muted">{tr.t("voucherCodeLabel")}</div>
            <div className="font-mono text-[26px] font-bold tracking-[0.08em] text-accent-deep">{v.code}</div>
          </div>

          {v.kind === "gift" ? (
            <div className="mb-5 text-center">
              <span className="text-[15px] text-secondary">{tr.t("voucherBalance")}: </span>
              <span className="text-[22px] font-bold text-accent-deep">{money(v.balance ?? 0)}</span>
            </div>
          ) : (
            v.product.package && (
              <div className="mb-5 rounded-[12px] border border-line bg-surface-alt/50 px-4 py-3.5 text-[14px] leading-[1.7] text-secondary">
                <div className="font-semibold text-ink">
                  {tr.p("night", v.product.package.nights)} · {tr.p("adult", v.product.package.adults)}
                  {v.product.package.children ? ` + ${tr.p("child", v.product.package.children)}` : ""}
                </div>
                {v.product.roomTitles.length > 0 && <div>{v.product.roomTitles.join(" · ")}</div>}
                {v.product.package.checkinDays.length > 0 && (
                  <div>{tr.t("voucherCheckinDays", { days: v.product.package.checkinDays.map((d) => WEEKDAY_LABELS[d]).join(" / ") })}</div>
                )}
                {(v.product.package.window?.from || v.product.package.window?.to) && (
                  <div>{tr.t("voucherStayWindow", { from: v.product.package.window.from ?? "…", to: v.product.package.window.to ?? "…" })}</div>
                )}
              </div>
            )
          )}

          <p className="mb-6 text-center text-[13px] text-muted">
            {tr.t("voucherValidUntil", { date: fmtDate(v.expiresAt, "d MMM yyyy") })}
          </p>

          <div className="flex flex-wrap justify-center gap-3">
            {v.kind === "package" && v.status === "active" && (
              <Link
                to={`/${params.channelId}/voucher/${v.code}/book`}
                className="rounded-[12px] bg-accent px-6 py-3.5 text-[16px] font-semibold text-white hover:bg-accent-deep"
              >
                {tr.t("voucherBookStay")}
              </Link>
            )}
            <a
              href={`/${params.channelId}/voucher/${v.code}/pdf`}
              className="rounded-[12px] border border-line-alt bg-surface px-6 py-3.5 text-[16px] font-semibold text-secondary hover:border-accent hover:text-accent"
            >
              {tr.t("voucherDownloadPdf")}
            </a>
          </div>
          {v.kind === "gift" && v.status === "active" && (
            <p className="mt-5 text-center text-[13.5px] leading-[1.6] text-muted">{tr.t("voucherGiftHow")}</p>
          )}

          {v.product.terms && (
            <p className="mt-6 border-t border-divider pt-4 text-[12px] leading-[1.6] text-muted-2">
              {tr.t("voucherTermsTitle")}: {v.product.terms}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
