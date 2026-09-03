import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { Link } from "react-router";

import type { Route } from "./+types/confirmation";
import { pageMeta } from "~/lib/page-meta";
import { useProperty } from "~/lib/booking-context";
import { cartCoverage, parseCart, type ResolvedLine } from "~/lib/cart";
import { formatMoney } from "~/lib/money";
import { langFromRequest } from "~/lib/content";
import { occLabel, useT } from "~/lib/i18n";
import { readOccupancy } from "~/lib/occupancy";
import { getPageText, getSettings } from "~/lib/overrides.server";
import { getBookingByReference } from "~/lib/bookings.server";
import { purchaseEvent } from "~/lib/tracking";
import { isTagged } from "~/lib/tracking-settings";
import { TrackEvent } from "~/components/tracking-events";

import { resolveAppliedPromo } from "~/lib/promotions.server";
import { taxConfigFrom } from "~/lib/pricing";
import { stayTotals } from "~/lib/checkout-totals";
import { resolveCartByOccupancy } from "~/lib/catalog.server";
import { getActiveExtras } from "~/lib/extras.server";
import { parseExtrasState, resolveAllExtras, type ResolvedExtra } from "~/lib/extras";
import { PriceBreakdown } from "~/components/price-breakdown";
import { basePath, useBase } from "~/lib/base";
import { resolveRequestProperty } from "~/lib/property-scope.server";
import { useSlots } from "~/components/site-style";
import { cx } from "~/lib/site-style";

export async function loader({ params, request }: Route.LoaderArgs) {
  const base = basePath(params.channelId);
  const url = new URL(request.url);
  const checkin = url.searchParams.get("checkin");
  const checkout = url.searchParams.get("checkout");
  const occ = readOccupancy(url.searchParams);
  const simulated = url.searchParams.get("sim") === "1";
  // Set by checkout/complete when finalize failed — the guest paid but the
  // booking couldn't be confirmed (Channex rejected / sold out + auto-refunded).
  const failed = url.searchParams.get("status") === "failed";
  const refunded = url.searchParams.get("refunded") === "1";
  const lang = langFromRequest(request);
  // :channelId may be a slug — resolve to the real id for data lookups; links
  // keep params.channelId so the slug stays in the URL.
  const pid = await resolveRequestProperty(params.channelId, request);

  // Currency is the property's, not the URL param — same rule as results and
  // checkout. Entry points that skip ?currency= (the embed widget, go.booking,
  // any shared link) otherwise landed the guest on a GBP-labelled confirmation.
  const settings = await getSettings(pid);
  const currency = settings.currency || "GBP";

  let rooms: { title: string; rate: string }[] = [];
  let lines: ResolvedLine[] = [];
  let total = 0;
  let nights = 0;
  let offer: { name: string; percent: number; discount: number } | null = null;
  let valueAdds: { name: string; inclusions: string[] }[] = [];
  let extraLines: ResolvedExtra[] = [];

  if (checkin && checkout) {
    nights = Math.max(1, differenceInCalendarDays(parseISO(checkout), parseISO(checkin)));
    lines = await resolveCartByOccupancy(
      pid,
      { checkin, checkout, currency },
      parseCart(url.searchParams),
      { adults: occ.adults, childrenAge: occ.childrenAge },
    );
    rooms = lines.map((l) => ({ title: l.roomTitle, rate: l.rateTitle }));
    // Stay-level, so any line carries the same list (see ResolvedLine.valueAdds).
    valueAdds = lines[0]?.valueAdds ?? [];
    if (lines.length) total = cartCoverage(lines).total;
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

  // The same stayTotals checkout charged from, so the itemisation here matches
  // the one the guest just paid. The searched party is only the headcount while
  // no cart lines resolve (the page reloaded without its cart params).
  const { pricing, grandTotal } = stayTotals(
    lines,
    extraLines,
    { nights, checkin: checkin ?? undefined, discount: applied?.discount },
    taxConfigFrom(settings),
    { adults: occ.adults, children: occ.childrenAge?.length ?? 0 },
  );

  // The analytics payload is built from the STORED booking, never from the
  // numbers above: everything this page displays is recomputed from query
  // params, so a guest editing the URL changes what they see. Reporting revenue
  // the same way would let a guest edit the hotel's Google Ads figures from the
  // address bar, and any drift from what was actually captured would show up as
  // revenue that never reconciles against Stripe. Null for an untagged property
  // (nothing to send), a failed booking, or a cancelled one.
  const booking = isTagged(settings.analytics) && params.ref ? await getBookingByReference(pid, params.ref) : undefined;
  const purchase = booking
    ? purchaseEvent(booking, { propertyId: pid, analytics: settings.analytics })
    : null;

  return {
    reference: params.ref,
    purchase,
    simulated,
    failed,
    refunded,
    rooms,
    currency,
    total,
    discount: applied?.discount ?? 0,
    promoCode: applied?.code ?? null,
    offer,
    valueAdds,
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

export function meta({ matches }: Route.MetaArgs) {
  return pageMeta(matches, { titleKey: "metaConfirmation", noindex: true });
}

export default function Confirmation({ loaderData, params }: Route.ComponentProps) {
  const base = useBase();
  const { reference, purchase, simulated, failed, refunded, rooms, currency, total, discount, promoCode, offer, valueAdds, pricing, extraLines, grandTotal, checkin, checkout, nights, adults, childrenAge, text } =
    loaderData;
  const { hotelName } = useProperty();
  const tr = useT();
  const s = useSlots();

  // Finalize failed after payment — never show the success card. Tell the guest
  // the truth (auto-refunded, or that we'll follow up) instead of "Confirmed".
  if (failed) {
    return (
      <main className="mx-auto max-w-[660px] px-7 pb-20 pt-16 text-center">
        <h1 className="mb-3 font-serif text-display-lg font-medium tracking-[-0.02em]">
          {tr.t("confirmProblemHeading")}
        </h1>
        <p className="mb-6 text-lead leading-[1.6] text-secondary">
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
            to={`${base}`}
            className="inline-block rounded-card border border-line-alt bg-surface-alt px-7 py-3.5 text-body-lg font-semibold text-secondary hover:border-accent hover:text-accent"
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
      {/* Once per booking reference, per tab. This page is refreshable,
          bookmarkable and reachable by back-navigation, and each of those would
          otherwise report another sale. Not rendered in the `failed` branch
          above — a refunded failure is not revenue. */}
      <TrackEvent event={purchase} dedupeKey={`rp_purchase_${reference}`} />
      {simulated && (
        <div className={cx("mb-6", s.well, "px-4 py-3 text-caption text-muted")}>
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
      <h1 className="mb-3 font-serif text-display-lg font-medium tracking-[-0.02em]">{text.heading}</h1>
      <p className="mb-2 text-title-sm leading-[1.6] text-secondary">
        {text.subtitle.replaceAll("{hotel}", hotelName)}
      </p>
      <div
        className="mb-9 inline-block rounded-full px-[18px] py-2 text-sm font-semibold tracking-[0.04em] text-accent"
        style={{ background: "var(--accent-soft)" }}
      >
        {tr.t("confirmationRef", { ref: reference })}
      </div>

      <div
        className={cx(s.strip, "p-[26px] text-left")}
        style={{ boxShadow: "var(--shadow-confirm)" }}
      >
        <div className={cx("flex flex-col gap-4 border-b", s.rule, "pb-5")}>
          {rooms.map((r, i) => (
            <div key={i} className="flex items-center gap-[18px]">
              <div className="h-16 w-[84px] flex-none rounded-card" style={{ background: stripe }} />
              <div>
                <div className="font-serif text-title-sm font-semibold">{r.title}</div>
                <div className="mt-[3px] text-caption text-muted-2">{r.rate}</div>
              </div>
            </div>
          ))}
        </div>
        {/* Included, right where the guest lands after booking — no amounts,
            because these are free and a money column would read as a charge. */}
        {valueAdds.map((va) => (
          <div key={va.name} className={cx("mt-5 flex flex-col gap-1.5 border-b", s.rule, "pb-5")}>
            <div className="text-label font-semibold uppercase tracking-wider text-accent-deep">
              {va.name || tr.t("includedTitle")}
            </div>
            {va.inclusions.map((inc, i) => (
              <div key={i} className="flex items-start gap-2 text-body">
                <span className="mt-[1px] flex-none font-semibold text-accent">✓</span>
                {inc}
              </div>
            ))}
          </div>
        ))}
        <div className="mt-5 flex flex-col gap-3 text-body-lg">
          <div className="flex justify-between">
            <span className="text-secondary">{tr.t("dates")}</span>
            <span className="font-semibold">{datesStr}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-secondary">{tr.t("guests")}</span>
            <span className="font-semibold">{guests}</span>
          </div>
          {total > 0 && offer && offer.discount > 0 && (
            <div className="flex justify-between text-success">
              <span>
                {offer.name} (−{offer.percent}%)
              </span>
              <span className="font-semibold">−{formatMoney(offer.discount, currency)}</span>
            </div>
          )}
          {total > 0 && discount > 0 && promoCode && (
            <div className="flex justify-between text-success">
              <span>
                {tr.t("discount")} ({promoCode})
              </span>
              <span className="font-semibold">−{formatMoney(discount, currency)}</span>
            </div>
          )}
          {/* Same component and section order as checkout — the guest sees the
              booking itemised exactly as they approved it one screen earlier. */}
          <PriceBreakdown
            pricing={pricing}
            extraLines={extraLines}
            grandTotal={grandTotal}
            currency={currency}
            variant="confirmation"
            showMoney={total > 0}
          />
        </div>
      </div>

      <Link
        to={`${base}`}
        className="mt-7 inline-block rounded-card border border-line-alt bg-surface-alt px-7 py-3.5 text-body-lg font-semibold text-secondary hover:border-accent hover:text-accent"
      >
        {text.newBooking}
      </Link>
    </main>
  );
}
