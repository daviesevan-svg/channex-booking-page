import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { Link } from "react-router";

import type { Route } from "./+types/confirmation";
import { useProperty } from "~/lib/booking-context";
import { cartCoverage, parseCart } from "~/lib/cart";
import { formatMoney } from "~/lib/money";
import { langFromRequest } from "~/lib/content";
import { occLabel, useT } from "~/lib/i18n";
import { readOccupancy } from "~/lib/occupancy";
import { getPageText, getSettings } from "~/lib/overrides.server";
import { resolvePropertyId } from "~/lib/properties.server";
import { resolveAppliedPromo } from "~/lib/promotions.server";
import { computePricing, taxConfigFrom } from "~/lib/pricing";
import { resolveCartByOccupancy } from "~/lib/catalog.server";
import { getActiveExtras } from "~/lib/extras.server";
import { groupExtrasByRoom, parseExtrasState, resolveAllExtras, taxableExtrasTotal, untaxedExtrasTotal, type ResolvedExtra } from "~/lib/extras";

export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const checkin = url.searchParams.get("checkin");
  const checkout = url.searchParams.get("checkout");
  const currency = url.searchParams.get("currency") || "GBP";
  const occ = readOccupancy(url.searchParams);
  const simulated = url.searchParams.get("sim") === "1";
  // Set by checkout/complete when finalize failed — the guest paid but the
  // booking couldn't be confirmed (Channex rejected / sold out + auto-refunded).
  const failed = url.searchParams.get("status") === "failed";
  const refunded = url.searchParams.get("refunded") === "1";
  const lang = langFromRequest(request);
  // :channelId may be a slug — resolve to the real id for data lookups; links
  // keep params.channelId so the slug stays in the URL.
  const pid = await resolvePropertyId(params.channelId);

  let rooms: { title: string; rate: string }[] = [];
  let total = 0;
  let nights = 0;
  let cleaningFee = 0;
  let offer: { name: string; percent: number; discount: number } | null = null;
  let extraLines: ResolvedExtra[] = [];

  if (checkin && checkout) {
    nights = Math.max(1, differenceInCalendarDays(parseISO(checkout), parseISO(checkin)));
    const lines = await resolveCartByOccupancy(
      pid,
      { checkin, checkout, currency },
      parseCart(url.searchParams),
      { adults: occ.adults, childrenAge: occ.childrenAge },
    );
    rooms = lines.map((l) => ({ title: l.roomTitle, rate: l.rateTitle }));
    if (lines.length) total = cartCoverage(lines).total;
    cleaningFee = lines.reduce((s, l) => s + l.cleaningFee, 0);
    // The automatic offer baked into the prices (per-line data), for the breakdown line.
    let orig = 0;
    let oName = "";
    let oPct = 0;
    for (const l of lines) {
      orig += l.originalTotal ?? l.total;
      if (l.offerName != null && l.offerPercent != null && (l.originalTotal ?? l.total) > l.total) {
        oName = l.offerName;
        oPct = l.offerPercent;
      }
    }
    if (oName) {
      offer = { name: oName, percent: oPct, discount: Math.round((Math.round(orig * 100) / 100 - total) * 100) / 100 };
    }
    // Extras carried in the URL, re-priced per room (its occupancy) / per booking.
    extraLines = resolveAllExtras(
      await getActiveExtras(pid),
      parseExtrasState(url.searchParams),
      lines.map((l) => ({
        roomId: l.roomId,
        rateId: l.rateId,
        roomTitle: l.roomTitle,
        guests: l.occupancy.adults + l.occupancy.children,
      })),
      nights,
      occ.adults + (occ.childrenAge?.length ?? 0),
    );
  }

  const applied =
    total > 0 ? await resolveAppliedPromo(pid, url.searchParams.get("promo") || "", total) : null;

  const discount = applied?.discount ?? 0;
  const settings = await getSettings(pid);
  const pricing = computePricing(
    {
      base: Math.round((total - discount) * 100) / 100,
      nights,
      adults: occ.adults,
      children: occ.childrenAge?.length ?? 0,
      rooms: rooms.length,
      cleaningFee,
      taxableExtras: taxableExtrasTotal(extraLines),
    },
    taxConfigFrom(settings),
  );

  const grandTotal = Math.round((pricing.total + untaxedExtrasTotal(extraLines)) * 100) / 100;

  return {
    reference: params.ref,
    simulated,
    failed,
    refunded,
    rooms,
    currency,
    total,
    discount,
    promoCode: applied?.code ?? null,
    offer,
    pricing,
    extraLines,
    grandTotal,
    checkin,
    checkout,
    nights,
    adults: occ.adults,
    childrenAge: occ.childrenAge,
    text: await getPageText(pid, "confirmation", lang),
  };
}

export default function Confirmation({ loaderData, params }: Route.ComponentProps) {
  const { reference, simulated, failed, refunded, rooms, currency, total, discount, promoCode, offer, pricing, extraLines, grandTotal, checkin, checkout, nights, adults, childrenAge, text } =
    loaderData;
  const { hotelName } = useProperty();
  const tr = useT();

  // Finalize failed after payment — never show the success card. Tell the guest
  // the truth (auto-refunded, or that we'll follow up) instead of "Confirmed".
  if (failed) {
    return (
      <main className="mx-auto max-w-[660px] px-7 pb-20 pt-16 text-center">
        <h1 className="mb-3 font-serif text-[40px] font-medium tracking-[-0.02em]">
          {tr.t("confirmProblemHeading")}
        </h1>
        <p className="mb-6 text-[17px] leading-[1.6] text-secondary">
          {(refunded ? tr.t("confirmRefundedBody") : tr.t("confirmProblemBody")).replaceAll("{hotel}", hotelName)}
        </p>
        <div
          className="mb-8 inline-block rounded-full px-[18px] py-2 text-sm font-semibold tracking-[0.04em] text-accent"
          style={{ background: "var(--accent-soft)" }}
        >
          {tr.t("confirmationRef", { ref: reference })}
        </div>
        <div>
          <Link
            to={`/${params.channelId}`}
            className="inline-block rounded-[12px] border border-line-alt bg-surface-alt px-7 py-3.5 text-[15px] font-semibold text-[#5a5145] hover:border-accent hover:text-accent"
          >
            {text.newBooking}
          </Link>
        </div>
      </main>
    );
  }
  const fmt = (d: Date, f: string) => format(d, f, { locale: tr.locale });
  const datesStr =
    checkin && checkout
      ? `${fmt(parseISO(checkin), "EEE d")} — ${fmt(parseISO(checkout), "EEE d MMM")} · ${tr.p(
          "night",
          nights,
        )}`
      : "";
  const guests = occLabel(tr, adults, childrenAge);
  const stripe = "repeating-linear-gradient(135deg,#efe7da,#efe7da 9px,#e7ddcc 9px,#e7ddcc 18px)";

  return (
    <main className="mx-auto max-w-[660px] px-7 pb-20 pt-16 text-center">
      {simulated && (
        <div className="mb-6 rounded-[10px] border border-line-alt bg-surface-alt px-4 py-3 text-[13px] text-muted">
          {tr.t("demoMode")}
        </div>
      )}
      <div
        className="mx-auto mb-7 flex h-[72px] w-[72px] items-center justify-center rounded-full"
        style={{ background: "var(--accent-soft-strong)" }}
      >
        <span
          className="block h-[13px] w-6"
          style={{
            borderLeft: "3px solid var(--accent)",
            borderBottom: "3px solid var(--accent)",
            transform: "rotate(-45deg)",
            marginTop: -5,
          }}
        />
      </div>
      <h1 className="mb-3 font-serif text-[44px] font-medium tracking-[-0.02em]">{text.heading}</h1>
      <p className="mb-2 text-[18px] leading-[1.6] text-secondary">
        {text.subtitle.replaceAll("{hotel}", hotelName)}
      </p>
      <div
        className="mb-9 inline-block rounded-full px-[18px] py-2 text-sm font-semibold tracking-[0.04em] text-accent"
        style={{ background: "var(--accent-soft)" }}
      >
        {tr.t("confirmationRef", { ref: reference })}
      </div>

      <div
        className="rounded-[18px] border border-line bg-surface p-[26px] text-left"
        style={{ boxShadow: "var(--shadow-confirm)" }}
      >
        <div className="flex flex-col gap-4 border-b border-divider pb-5">
          {rooms.map((r, i) => (
            <div key={i} className="flex items-center gap-[18px]">
              <div className="h-16 w-[84px] flex-none rounded-[12px]" style={{ background: stripe }} />
              <div>
                <div className="font-serif text-[19px] font-semibold">{r.title}</div>
                <div className="mt-[3px] text-[13.5px] text-muted-2">{r.rate}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-5 flex flex-col gap-3 text-[15px]">
          <div className="flex justify-between">
            <span className="text-secondary">{tr.t("dates")}</span>
            <span className="font-semibold">{datesStr}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-secondary">{tr.t("guests")}</span>
            <span className="font-semibold">{guests}</span>
          </div>
          {total > 0 && offer && offer.discount > 0 && (
            <div className="flex justify-between text-[#3f7a52]">
              <span>
                {offer.name} (−{offer.percent}%)
              </span>
              <span className="font-semibold">−{formatMoney(offer.discount, currency)}</span>
            </div>
          )}
          {total > 0 && discount > 0 && promoCode && (
            <div className="flex justify-between text-[#3f7a52]">
              <span>
                {tr.t("discount")} ({promoCode})
              </span>
              <span className="font-semibold">−{formatMoney(discount, currency)}</span>
            </div>
          )}
          {total > 0 &&
            pricing.charges.map((c, i) => (
              <div key={`charge-${i}`} className="flex justify-between">
                <span className="text-secondary">{c.label}</span>
                <span className="font-semibold">{formatMoney(c.amount, currency)}</span>
              </div>
            ))}
          {total > 0 &&
            pricing.taxLines.map((c, i) => (
              <div key={`tax-${i}`} className="flex justify-between">
                <span className="text-secondary">{c.label}</span>
                <span className="font-semibold">{formatMoney(c.amount, currency)}</span>
              </div>
            ))}
          {groupExtrasByRoom(extraLines).map((g, gi) => (
            <div key={gi} className="flex flex-col gap-1">
              <div className="text-[12.5px] font-semibold text-secondary">{g.roomTitle ?? tr.t("forYourStay")}</div>
              {g.lines.map((l) => (
                <div key={`${l.id}-${l.optionId ?? ""}`} className="flex justify-between pl-2">
                  <span className="text-secondary">
                    {l.optionName ? `${l.name} · ${l.optionName}` : l.name}
                    {l.qty > 1 ? ` ×${l.qty}` : ""}
                    {l.infoLine ? <span className="block text-[12px] text-muted-2">{l.infoLine}</span> : null}
                  </span>
                  <span className="font-semibold">{formatMoney(l.amount, currency)}</span>
                </div>
              ))}
            </div>
          ))}
          {total > 0 && (
            <div className="flex items-baseline justify-between border-t border-divider pt-3">
              <span className="text-secondary">{tr.t("total")}</span>
              <span className="font-serif text-[24px] font-semibold">
                {formatMoney(grandTotal, currency)}
              </span>
            </div>
          )}
          {total > 0 && pricing.taxIncluded > 0 && (
            <div className="text-right text-[12px] text-muted-2">
              {tr.t("includesTaxes", { amount: formatMoney(pricing.taxIncluded, currency) })}
            </div>
          )}
        </div>
      </div>

      <Link
        to={`/${params.channelId}`}
        className="mt-7 inline-block rounded-[12px] border border-line-alt bg-surface-alt px-7 py-3.5 text-[15px] font-semibold text-[#5a5145] hover:border-accent hover:text-accent"
      >
        {text.newBooking}
      </Link>
    </main>
  );
}
