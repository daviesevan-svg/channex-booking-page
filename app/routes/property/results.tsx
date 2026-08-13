import { differenceInCalendarDays, format, parseISO } from "date-fns";

import { useEffect, useState } from "react";
import { Link, redirect, useNavigate, useNavigation, useSearchParams } from "react-router";
import { jsonLdHtml } from "~/lib/jsonld";

import type { Route } from "./+types/results";
import { pageMeta } from "~/lib/page-meta";
import type { RoomWithRates } from "~/lib/channex/types";
import { useProperty } from "~/lib/booking-context";
import {
  cartCoverage,
  cartCovers,
  parseCart,
  removeIndex,
  roomCounts,
  serializeCart,
  type ResolvedLine,
} from "~/lib/cart";
import { extrasTotal, parseExtrasState, removeExtrasLine, resolveAllExtras, serializeExtrasState } from "~/lib/extras";
import { getActiveExtras } from "~/lib/extras.server";
import { getCatalogRooms, resolveCartByOccupancy } from "~/lib/catalog.server";
import { catalogHotelJsonLd } from "~/lib/hotel-jsonld.server";
import { getPageText } from "~/lib/overrides.server";

import { queueSearchEvent } from "~/lib/search-analytics.server";
import { funnelContext, queueFunnelEvent } from "~/lib/funnel-analytics.server";
import { computePricing, taxConfigFrom } from "~/lib/pricing";
import { langFromRequest } from "~/lib/content";
import { occLabel, useT } from "~/lib/i18n";
import { formatMoney } from "~/lib/money";
import {
  childrenAgeParam,
  partySize,
  ratePlansForParty,
  roomAvailability,
  roomCapacity,
  roomFits,
} from "~/lib/occupancy";
import { useBase, useHome } from "~/lib/base";
import { useSlots } from "~/components/site-style";
import { cx } from "~/lib/site-style";
import { requireDatedStay } from "~/lib/dated-stay.server";

export async function loader({ params, request }: Route.LoaderArgs) {
  const { pid, base, url, checkin, checkout, occ, currency, nights, settings } =
    await requireDatedStay(params.channelId, request);
  const lang = langFromRequest(request);

  const rooms = await getCatalogRooms(
    pid,
    {
      checkinDate: checkin,
      checkoutDate: checkout,
      currency,
      adults: occ.adults,
      childrenAge: childrenAgeParam(occ.childrenAge),
    },
    { gate: true },
  );

  const party = partySize(occ);

  // Can the property seat this party AT ALL on these dates — even taking every
  // bookable room? Sum each room type's (sellable count × its capacity). If the
  // ceiling is below the party (or there aren't enough adult beds), no cart can
  // ever cover them, so we warn instead of dangling a "add another room" prompt
  // with nothing left to add. (Computed before the single-unit redirect so the
  // search log below sees every search.)
  const avail = (room: RoomWithRates) => {
    const a = roomAvailability(room);
    return Number.isFinite(a) ? a : 99;
  };
  const maxCapacity = rooms.reduce((s, r) => s + avail(r) * roomCapacity(r).capacity, 0);
  const maxAdultsCap = rooms.reduce((s, r) => s + avail(r) * roomCapacity(r).maxAdults, 0);
  const fitsParty = maxCapacity >= party && maxAdultsCap >= occ.adults;

  // Demand analytics for the admin dashboard: log each fresh search (an empty
  // cart — adding rooms re-runs this loader with the same dates, and prefetches
  // don't count). Non-fatal by design.
  // Funnel step: this page is `results` on a fresh search, `cart` once rooms
  // are selected (same loader, distinguished by the sel param — see cart.ts).
  const cartSize = parseCart(url.searchParams).length;
  const fc = await funnelContext(request);
  if (fc) {
    queueFunnelEvent({
      propertyId: pid,
      step: cartSize > 0 ? "cart" : "results",
      visitKey: fc.visitKey,
      source: "web",
      checkin,
      nights,
      adults: occ.adults,
      children: occ.childrenAge?.length ?? 0,
      rooms: cartSize || undefined,
      currency,
      country: fc.country,
      lang,
      device: fc.device,
    });
  }

  const purpose = request.headers.get("sec-purpose") ?? request.headers.get("purpose") ?? "";
  if (parseCart(url.searchParams).length === 0 && !purpose.includes("prefetch")) {
    queueSearchEvent({
      propertyId: pid,
      checkin,
      checkout,
      nights,
      leadDays: Math.max(0, differenceInCalendarDays(parseISO(checkin), new Date())),
      adults: occ.adults,
      children: occ.childrenAge?.length ?? 0,
      country:
        request.headers.get("cf-ipcountry") ??
        (request as { cf?: { country?: string } }).cf?.country ??
        null,
      lang,
      hasAvailability: rooms.length > 0 && fitsParty,
      resultsCount: rooms.length,
    });
  }

  // Single-unit properties have no room list. Send an empty cart straight to the
  // one unit's page (this catches landing searches AND widget/deep-link hits on
  // /rooms). Once a room is in the cart we fall through and render the review.
  if (settings.singleUnit && parseCart(url.searchParams).length === 0 && rooms.length > 0) {
    throw redirect(`${base}/rooms/${rooms[0].id}?${url.searchParams.toString()}`);
  }

  const cheapest = (room: RoomWithRates) =>
    Math.min(...ratePlansForParty(room, party).map((r) => Number(r.totalPrice)));

  const enriched = rooms
    .map((room) => ({ ...room, fits: roomFits(room, occ) }))
    .sort((a, b) => Number(b.fits) - Number(a.fits) || cheapest(a) - cheapest(b));

  const bestMatchId = enriched.find((r) => r.fits)?.id ?? null;
  const text = await getPageText(pid, "results", lang);

  // Tax-/fee-inclusive (all-in) total per rate, so the headline price matches the
  // checkout total and the Google structured data. Computed once here and shown
  // both on the card and in the JSON-LD below.
  const taxConfig = taxConfigFrom(settings);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const allIn = (base: number, cleaningFee: number) =>
    r2(
      computePricing(
        { base, nights, adults: occ.adults, children: occ.childrenAge?.length ?? 0, rooms: 1, cleaningFee, taxableExtras: 0, checkin },
        taxConfig,
      ).total,
    );
  const priced = enriched.map((room) => ({
    ...room,
    ratePlans: room.ratePlans.map((rp) => ({
      ...rp,
      allInTotal: allIn(Number(rp.totalPrice), room.cleaningFee ?? 0),
      allInOriginal: rp.offer ? allIn(Number(rp.offer.originalTotalPrice), room.cleaningFee ?? 0) : undefined,
    })),
  }));

  const cartLines = await resolveCartByOccupancy(
    pid,
    { checkin, checkout, currency },
    parseCart(url.searchParams),
    { adults: occ.adults, childrenAge: occ.childrenAge },
  );
  const coverage = cartCoverage(cartLines);
  const covered = cartCovers(cartLines, occ);

  // Extras selected so far, so the cart total here matches checkout.
  const extraLines = resolveAllExtras(
    await getActiveExtras(pid),
    parseExtrasState(url.searchParams),
    cartLines.map((l) => ({
      roomId: l.roomId,
      rateId: l.rateId,
      roomTitle: l.roomTitle,
      guests: l.occupancy.adults + l.occupancy.children,
    })),
    nights,
    party,
  );
  const extrasSum = extrasTotal(extraLines);

  // Google Hotel price structured data — every bookable room + its rates, at the
  // all-in price (so Google shows the same total the guest pays at checkout).
  const jsonLd = await catalogHotelJsonLd(
    pid,
    lang,
    { checkin, checkout },
    priced.map((room) => ({
      roomId: room.id,
      name: room.title,
      occupancy: party,
      image: room.photos?.[0]?.url,
      offers: ratePlansForParty(room, party).map((rp) => ({
        rateId: rp.parentRatePlanId ?? rp.id,
        total: rp.allInTotal ?? Number(rp.totalPrice),
      })),
    })),
  );

  return {
    rooms: priced,
    nights,
    bestMatchId,
    party: partySize(occ),
    fitsParty,
    maxCapacity,
    cartLines,
    coverage,
    covered,
    extrasSum,
    text,
    jsonLd,
    singleUnit: settings.singleUnit ?? false,
    query: { checkin, checkout, currency, adults: occ.adults, childrenAge: occ.childrenAge },
  };
}

type EnrichedRoom = RoomWithRates & { fits: boolean };

function RoomCard({
  room,
  isBestMatch,
  currency,
  nights,
  party,
  channelId,
  qs,
  inCart,
}: {
  room: EnrichedRoom;
  isBestMatch: boolean;
  currency: string;
  nights: number;
  party: number;
  channelId: string | undefined;
  qs: string;
  inCart: number;
}) {
  const base = useBase();
  const s = useSlots();
  const home = useHome();
  const tr = useT();
  const available = roomAvailability(room);
  const remaining = Number.isFinite(available) ? available - inCart : Infinity;
  const atMax = remaining <= 0;
  const sorted = ratePlansForParty(room, party).sort(
    (a, b) => Number(a.totalPrice) - Number(b.totalPrice),
  );
  // The card is a summary; the guest picks a rate on the room detail page.
  const cheapest = sorted[0];
  const cheapestTotal = cheapest ? (cheapest.allInTotal ?? Number(cheapest.totalPrice)) : 0;
  const perNight = cheapestTotal / nights;
  const photo = room.photos?.[0]?.url;
  // Structured amenities (translated) first, then free-text — first 4 as chips.
  const amenities = [
    ...(room.amenities ?? []).map((k: string) => tr.t(`am_${k}`)),
    ...(room.facilities ?? []),
  ].slice(0, 4);
  const { maxAdults, capacity } = roomCapacity(room);
  const detailHref = `${base}/rooms/${room.id}?${qs}`;

  return (
    <div
      className={cx(
        "flex flex-wrap overflow-hidden",
        s.panel,
        "transition-all duration-200 hover:-translate-y-[3px] hover:shadow-[0_20px_40px_-26px_rgba(70,55,35,0.4)]",
        isBestMatch && "ring-2 ring-accent",
      )}
    >
      {/* The card is a wrapping flex row: the media column's fixed 230px is right
          once the row is side by side, but on a ~333px phone card it left a bare
          strip of card beside every photo. Full width until the row actually has
          room for two columns. */}
      <Link
        to={detailHref}
        prefetch="intent"
        className="relative min-h-[200px] w-full flex-none self-stretch sm:w-[230px]"
      >
        {photo ? (
          <img src={photo} alt={room.title} className="h-full w-full object-cover" />
        ) : (
          <div
            className="h-full w-full"
            style={{
              background:
                "repeating-linear-gradient(135deg,#efe7da,#efe7da 11px,#e7ddcc 11px,#e7ddcc 22px)",
            }}
          />
        )}
        {isBestMatch && (
          <span className="absolute left-3 top-3 rounded-full bg-accent px-3 py-1 text-label font-semibold text-white">
            {tr.t("bestMatch")}
          </span>
        )}
      </Link>
      <div className="flex min-w-[240px] flex-1 flex-col p-6">
        <Link to={detailHref} prefetch="intent">
          <h3 className="mb-1.5 font-serif text-title-lg font-semibold tracking-[-0.01em] hover:text-accent">
            {room.title}
          </h3>
        </Link>
        <div className="mb-3 text-caption font-semibold text-muted-2">
          {tr.t("sleeps", { n: capacity })}
          {capacity > maxAdults && (
            <span className="font-normal text-faint">
              {" · "}
              {tr.p("adult", maxAdults)} + {tr.p("child", capacity - maxAdults)}
            </span>
          )}
        </div>
        {room.description && (
          <p className="mb-4 max-w-[440px] text-body leading-[1.55] text-secondary line-clamp-2">
            {room.description}
          </p>
        )}
        <div className="mt-auto flex flex-wrap gap-2">
          {amenities.map((a) => (
            <span
              key={a}
              className="rounded-full border border-chip-border bg-chip px-3 py-[5px] text-label font-medium text-secondary"
            >
              {a}
            </span>
          ))}
        </div>
      </div>
      <div className="flex w-[250px] flex-none flex-col items-stretch justify-center gap-2.5 border-l border-divider p-5 text-right">
        {cheapest?.offer && (
          <div className="self-end rounded-full bg-[#ece6f0] px-2.5 py-0.5 text-micro font-semibold text-[#6b4f8a]">
            {cheapest.offer.name} · −{cheapest.offer.percent}%
          </div>
        )}
        {/* Value-adds are stay-level, so every rate carries the same list and
            reading it off `cheapest` shows it once per card. Deliberately NOT
            the discount badge's colours: a "−10%" and an "includes dinner" chip
            that look alike make the second one read as a price claim. */}
        {cheapest?.valueAdds?.map((va) =>
          va.name ? (
            <div
              key={va.name}
              className="self-end rounded-full bg-accent-soft px-2.5 py-0.5 text-micro font-semibold text-accent-deep"
            >
              {va.name}
            </div>
          ) : null,
        )}
        <div>
          <span className="text-caption text-muted-2">{tr.t("from")} </span>
          {cheapest?.offer && (
            <span className="mr-1.5 text-body-lg text-muted-2 line-through">
              {formatMoney((cheapest.allInOriginal ?? Number(cheapest.offer.originalTotalPrice)) / nights, currency)}
            </span>
          )}
          <span className="font-serif text-display-sm font-semibold">
            {formatMoney(perNight, currency)}
          </span>
          <div className="text-label text-muted-2">{tr.t("perNightInclTaxes")}</div>
        </div>
        {!atMax && remaining <= 5 && (
          <div className="text-label font-medium text-accent">{tr.t("onlyLeft", { n: remaining })}</div>
        )}
        {atMax ? (
          <div className="rounded-control bg-surface-alt py-[11px] text-center text-caption font-medium text-muted-2">
            {tr.t("allAvailableAdded", { n: available })}
          </div>
        ) : (
          // prefetch="intent": the detail loader starts on hover, so choosing a
          // rate doesn't wait a full round trip. Analytics stay honest —
          // funnelContext() ignores prefetch requests.
          <Link
            to={detailHref}
            prefetch="intent"
            className="w-full rounded-control bg-accent py-[11px] text-center text-body-lg font-semibold text-white transition-colors hover:bg-accent-deep"
          >
            {tr.t("chooseRate")}
          </Link>
        )}
      </div>
    </div>
  );
}

function CartPanel({
  lines,
  coverage,
  covered,
  fitsParty,
  party,
  currency,
  onRemove,
  onContinue,
  continuePending,
  cartTitle,
  continueLabel,
  channelId,
  qs,
  extrasCounts,
  extrasSum,
}: {
  lines: ResolvedLine[];
  coverage: { capacity: number; total: number };
  covered: boolean;
  fitsParty: boolean;
  party: number;
  currency: string;
  onRemove: (index: number) => void;
  onContinue: () => void;
  continuePending: boolean;
  cartTitle: string;
  continueLabel: string;
  channelId: string | undefined;
  qs: string;
  extrasCounts: number[];
  extrasSum: number;
}) {
  const base = useBase();
  const s = useSlots();
  const home = useHome();
  const tr = useT();
  return (
    <aside
      className={cx("sticky top-24 w-full min-w-[280px] flex-1 self-start", s.strip, "p-6")}
      style={{ boxShadow: "var(--shadow-sticky)" }}
    >
      {cartTitle && <h3 className="mb-1 font-serif text-title-md font-semibold">{cartTitle}</h3>}
      <div className="mb-4 text-caption text-muted-2">
        {lines.length === 0 ? tr.t("noRoomsSelected") : tr.p("roomsSelected", lines.length)}
      </div>

      {lines.length > 0 && (
        <div className={cx("mb-4 flex flex-col gap-3 border-b", s.rule, "pb-4")}>
          {lines.map((l, i) => (
            <div key={`${l.roomId}-${l.rateId}-${i}`} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link
                  to={`${base}/rooms/${l.roomId}?edit=${i}&${qs}`}
                  className="group block"
                  title={tr.t("updateRoom")}
                >
                  <div className="truncate text-body font-semibold group-hover:text-accent">
                    {l.roomTitle}
                  </div>
                  <div className="text-label text-muted-2">
                    {l.rateTitle} · {tr.p("adult", l.occupancy.adults)}
                    {l.occupancy.children ? `, ${tr.p("child", l.occupancy.children)}` : ""}
                    <span className="ml-1 text-micro text-accent">✎</span>
                  </div>
                </Link>
                <Link
                  to={`${base}/extras?line=${i}&${qs}`}
                  prefetch="intent"
                  className="mt-1 inline-block text-label font-semibold text-accent hover:underline"
                >
                  {extrasCounts[i] ? tr.t("editExtrasCount", { n: extrasCounts[i] }) : tr.t("addExtras")}
                </Link>
              </div>
              <div className="flex items-center gap-2 whitespace-nowrap">
                <span className="text-body font-semibold">{formatMoney(l.total, currency)}</span>
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  aria-label="Remove room"
                  className="text-title-sm leading-none text-muted-2 hover:text-accent"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div
        className="mb-4 flex items-center gap-2 rounded-control px-3.5 py-2.5 text-caption font-semibold"
        style={{
          background: covered ? "#e8f0e6" : "#f5efe5",
          color: covered ? "#3f7a52" : "var(--color-muted)",
        }}
      >
        {covered ? (
          <span className="flex-none text-body leading-none" style={{ color: "#3f7a52" }}>
            ✓
          </span>
        ) : (
          <span
            className="h-[7px] w-[7px] flex-none rounded-mark bg-accent"
            style={{ transform: "rotate(45deg)" }}
          />
        )}
        {covered
          ? tr.t("sleepsAll", { n: party })
          : fitsParty
            ? tr.t("sleepsOf", { x: coverage.capacity, y: party })
            : tr.t("capacityShort", { x: coverage.capacity, y: party })}
      </div>

      {extrasSum > 0 && (
        <div className="mb-2 flex items-baseline justify-between text-caption">
          <span className="text-secondary">{tr.t("extrasLabel")}</span>
          <span className="font-semibold">{formatMoney(extrasSum, currency)}</span>
        </div>
      )}
      <div className="mb-4 flex items-baseline justify-between">
        <span className="text-body-lg font-semibold">{tr.t("total")}</span>
        <span className="font-serif text-display-sm font-semibold">
          {formatMoney(coverage.total + extrasSum, currency)}
        </span>
      </div>

      <button
        type="button"
        onClick={onContinue}
        disabled={!covered || continuePending}
        className={cx(
          "w-full",
          s.btnPrimary,
          "py-[14px] text-lead font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        {continuePending ? tr.t("loading") : continueLabel}
      </button>
    </aside>
  );
}

/** Running total + continue, pinned to the bottom of a narrow screen.
 *
 *  The CartPanel is `sticky`, which only sticks while it sits in its own column
 *  beside the list. Below `lg` the two columns stack, so it landed under every
 *  room card — pick the first room and "continue" was 3,300px down a 4,300px
 *  page, past five rooms you'd already decided against. This is the same two
 *  numbers and the same action, always in reach. Shown only once something is
 *  selected; with an empty cart there is nothing to continue to. */
function MobileCartBar({
  count,
  total,
  currency,
  covered,
  continuePending,
  onContinue,
  continueLabel,
}: {
  count: number;
  total: number;
  currency: string;
  covered: boolean;
  continuePending: boolean;
  onContinue: () => void;
  continueLabel: string;
}) {
  const s = useSlots();
  const tr = useT();
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 border-t border-nav-border px-5 pb-[calc(12px+env(safe-area-inset-bottom))] pt-3 lg:hidden"
      style={{ background: "var(--page)", boxShadow: "0 -10px 30px -22px rgba(70,55,35,0.5)" }}
    >
      <div className="mx-auto flex max-w-[560px] items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-label text-muted-2">{tr.p("roomsSelected", count)}</div>
          <div className="font-serif text-title-md font-semibold">{formatMoney(total, currency)}</div>
        </div>
        <button
          type="button"
          onClick={onContinue}
          disabled={!covered || continuePending}
          className={cx(
            "flex-none",
            s.btnPrimary,
            "px-5 py-[13px] text-body font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {continuePending ? tr.t("loading") : continueLabel}
        </button>
      </div>
    </div>
  );
}

export function meta({ matches }: Route.MetaArgs) {
  return pageMeta(matches, { titleKey: "metaRooms", descKey: "metaDescRooms" });
}

export default function Results({ loaderData, params }: Route.ComponentProps) {
  const base = useBase();
  const s = useSlots();
  const home = useHome();
  const { rooms, nights, bestMatchId, party, fitsParty, maxCapacity, cartLines, coverage, covered, extrasSum, text, jsonLd, singleUnit, query } = loaderData;
  const { currency } = useProperty();
  const tr = useT();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const qs = searchParams.toString();

  const cart = parseCart(searchParams);
  const counts = roomCounts(cart);

  const [continuePending, setContinuePending] = useState(false);
  useEffect(() => {
    if (navigation.state === "idle") setContinuePending(false);
  }, [navigation.state]);

  // Removing a room drops its row from both the cart and the aligned per-line
  // extras buckets, so the remaining lines keep their own extras.
  const onRemove = (index: number) => {
    const sel = serializeCart(removeIndex(cart, index));
    const xt = serializeExtrasState(removeExtrasLine(parseExtrasState(searchParams), index));
    const next = new URLSearchParams(searchParams);
    if (sel) next.set("sel", sel);
    else next.delete("sel");
    if (xt) next.set("xt", xt);
    else next.delete("xt");
    navigate(`${base}/rooms?${next.toString()}`);
  };
  const onContinue = () => {
    setContinuePending(true);
    // Extras are now collected per room during selection, so go straight to checkout.
    navigate(`${base}/checkout?${searchParams.toString()}`);
  };

  // Per-line extras count, for the "Edit extras" affordance in the cart.
  const extrasState = parseExtrasState(searchParams);
  const extrasCounts = cart.map((_, i) => extrasState.lines[i]?.length ?? 0);

  // Drives both the pinned bar and the bottom padding that keeps it from
  // covering the last room card.
  const showCartBar = !singleUnit && rooms.length > 0 && cartLines.length > 0;

  const fmt = (d: Date, f: string) => format(d, f, { locale: tr.locale });
  const summary = `${fmt(parseISO(query.checkin), "EEE d")} — ${fmt(
    parseISO(query.checkout),
    "EEE d MMM",
  )} · ${tr.p("night", nights)} · ${occLabel(tr, query.adults, query.childrenAge)}`;

  return (
    <main
      className={cx(
        "mx-auto max-w-[1160px] px-7 pt-10",
        showCartBar ? "pb-[150px] lg:pb-[72px]" : "pb-[72px]",
      )}
    >
      {jsonLd && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(jsonLd) }} />
      )}
      <div className="mb-[26px] flex flex-wrap items-end justify-between gap-5">
        <div>
          <h1 className="mb-2 font-serif text-display-lg font-medium tracking-[-0.02em]">
            {singleUnit ? text.cartTitle : text.heading}
          </h1>
          {/* Summary only. The "edit search" affordance is the button beside it —
              having both meant two identical controls side by side at every
              width, and on a phone they stacked one under the other. */}
          <div className="text-body-lg text-secondary">{summary}</div>
        </div>
        <Link
          to={`${base}?${qs}`}
          className={cx(
            s.btnSecondary,
            "px-[18px] py-[11px] text-sm font-semibold text-[#5a5145] hover:border-accent hover:text-accent",
          )}
        >
          {text.editSearch}
        </Link>
      </div>

      {rooms.length > 0 && !fitsParty && (
        <div className="mb-6 rounded-card border border-accent/40 bg-[#f9ede6] p-5">
          <div className="mb-1 font-serif text-title-sm font-semibold text-[#8a4a2f]">
            {tr.t("capacityTitle", { n: party })}
          </div>
          <p className="text-body text-secondary">
            {tr.t("capacityBody", { max: maxCapacity })}{" "}
            <Link
              to={`${base}?${qs}`}
              className="font-semibold text-accent underline-offset-2 hover:underline"
            >
              {text.editSearch}
            </Link>
          </p>
        </div>
      )}

      {rooms.length === 0 ? (
        <p className="text-secondary">
          {tr.t("noAvailability")}{" "}
          <Link to={`${base}?${qs}`} className="font-semibold text-accent">
            {tr.t("tryDifferentDates")}
          </Link>
          .
        </p>
      ) : singleUnit ? (
        // Single-unit review: no room list, just the booking summary + checkout.
        <div className="mx-auto max-w-[560px]">
          <CartPanel
            lines={cartLines}
            coverage={coverage}
            covered={covered}
            fitsParty={fitsParty}
            party={party}
            currency={currency}
            onRemove={onRemove}
            onContinue={onContinue}
            continuePending={continuePending}
            cartTitle=""
            continueLabel={text.continueButton}
            channelId={params.channelId}
            qs={qs}
            extrasCounts={extrasCounts}
            extrasSum={extrasSum}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-8 lg:flex-row lg:items-start">
          <div className="flex flex-[1.7] flex-col gap-4">
            {rooms.map((room) => (
              <RoomCard
                key={room.id}
                room={room}
                isBestMatch={room.id === bestMatchId}
                currency={currency}
                nights={nights}
                party={party}
                channelId={params.channelId}
                qs={qs}
                inCart={counts.get(room.id) ?? 0}
              />
            ))}
          </div>
          <div className="lg:w-[340px]">
            <CartPanel
              lines={cartLines}
              coverage={coverage}
              covered={covered}
              fitsParty={fitsParty}
              party={party}
              currency={currency}
              onRemove={onRemove}
              onContinue={onContinue}
              continuePending={continuePending}
              cartTitle={text.cartTitle}
              continueLabel={text.continueButton}
              channelId={params.channelId}
              qs={qs}
              extrasCounts={extrasCounts}
              extrasSum={extrasSum}
            />
          </div>
        </div>
      )}

      {showCartBar && (
        <MobileCartBar
          count={cartLines.length}
          total={coverage.total + extrasSum}
          currency={currency}
          covered={covered}
          continuePending={continuePending}
          onContinue={onContinue}
          continueLabel={text.continueButton}
        />
      )}
    </main>
  );
}
