import { differenceInCalendarDays, format, parseISO } from "date-fns";

import { isStayBookable, isTooLastMinute } from "~/lib/dates";
import { getBookingCutoff } from "~/lib/overrides.server";
import { useEffect, useState } from "react";
import { Link, redirect, useNavigate, useNavigation, useSearchParams } from "react-router";
import { jsonLdHtml } from "~/lib/jsonld";

import type { Route } from "./+types/results";
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
import { getPageText, getSettings } from "~/lib/overrides.server";
import { resolvePropertyId } from "~/lib/properties.server";
import { computePricing, taxConfigFrom } from "~/lib/pricing";
import { langFromRequest } from "~/lib/content";
import { occLabel, useT } from "~/lib/i18n";
import { formatMoney } from "~/lib/money";
import {
  childrenAgeParam,
  partySize,
  ratePlansForParty,
  readOccupancy,
  roomAvailability,
  roomCapacity,
  roomFits,
} from "~/lib/occupancy";

export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const checkin = url.searchParams.get("checkin");
  const checkout = url.searchParams.get("checkout");
  const occ = readOccupancy(url.searchParams);
  const lang = langFromRequest(request);
  // :channelId may be a slug — resolve to the real id for data lookups; redirects
  // and links keep params.channelId so the slug stays in the URL.
  const pid = await resolvePropertyId(params.channelId);

  if (!checkin || !checkout || !isStayBookable(checkin, checkout)) {
    throw redirect(`/${params.channelId}`);
  }
  if (isTooLastMinute(checkin, await getBookingCutoff(pid))) {
    throw redirect(`/${params.channelId}`);
  }

  // Currency is the property's, not the URL param — there's no conversion, so a
  // spoofed ?currency= would only mislabel prices (and the charge; see checkout).
  const settings = await getSettings(pid);
  const currency = settings.currency || "GBP";

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
  const cheapest = (room: RoomWithRates) =>
    Math.min(...ratePlansForParty(room, party).map((r) => Number(r.totalPrice)));

  const enriched = rooms
    .map((room) => ({ ...room, fits: roomFits(room, occ) }))
    .sort((a, b) => Number(b.fits) - Number(a.fits) || cheapest(a) - cheapest(b));

  const bestMatchId = enriched.find((r) => r.fits)?.id ?? null;
  const nights = Math.max(1, differenceInCalendarDays(parseISO(checkout), parseISO(checkin)));
  const text = await getPageText(pid, "results", lang);

  // Tax-/fee-inclusive (all-in) total per rate, so the headline price matches the
  // checkout total and the Google structured data. Computed once here and shown
  // both on the card and in the JSON-LD below.
  const taxConfig = taxConfigFrom(settings);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const allIn = (base: number, cleaningFee: number) =>
    r2(
      computePricing(
        { base, nights, adults: occ.adults, children: occ.childrenAge?.length ?? 0, rooms: 1, cleaningFee, taxableExtras: 0 },
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
    cartLines,
    coverage,
    covered,
    extrasSum,
    text,
    jsonLd,
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
  channelId: string;
  qs: string;
  inCart: number;
}) {
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
  const amenities = (room.facilities ?? []).slice(0, 4);
  const { capacity } = roomCapacity(room);
  const detailHref = `/${channelId}/rooms/${room.id}?${qs}`;

  return (
    <div
      className={`flex flex-wrap overflow-hidden rounded-[16px] border border-line bg-surface transition-all duration-200 hover:-translate-y-[3px] hover:shadow-[0_20px_40px_-26px_rgba(70,55,35,0.4)] ${
        isBestMatch ? "ring-2 ring-accent" : ""
      }`}
    >
      <Link to={detailHref} className="relative min-h-[200px] w-[230px] flex-none self-stretch">
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
          <span className="absolute left-3 top-3 rounded-full bg-accent px-3 py-1 text-[12px] font-semibold text-white">
            {tr.t("bestMatch")}
          </span>
        )}
      </Link>
      <div className="flex min-w-[240px] flex-1 flex-col p-6">
        <Link to={detailHref}>
          <h3 className="mb-1.5 font-serif text-[24px] font-semibold tracking-[-0.01em] hover:text-accent">
            {room.title}
          </h3>
        </Link>
        <div className="mb-3 text-[13.5px] font-semibold text-muted-2">{tr.t("sleeps", { n: capacity })}</div>
        {room.description && (
          <p className="mb-4 max-w-[440px] text-[14.5px] leading-[1.55] text-secondary line-clamp-2">
            {room.description}
          </p>
        )}
        <div className="mt-auto flex flex-wrap gap-2">
          {amenities.map((a) => (
            <span
              key={a}
              className="rounded-full border border-chip-border bg-chip px-3 py-[5px] text-[12.5px] font-medium text-secondary"
            >
              {a}
            </span>
          ))}
        </div>
      </div>
      <div className="flex w-[250px] flex-none flex-col items-stretch justify-center gap-2.5 border-l border-divider p-5 text-right">
        {cheapest?.offer && (
          <div className="self-end rounded-full bg-[#ece6f0] px-2.5 py-0.5 text-[11px] font-semibold text-[#6b4f8a]">
            {cheapest.offer.name} · −{cheapest.offer.percent}%
          </div>
        )}
        <div>
          <span className="text-[13px] text-muted-2">{tr.t("from")} </span>
          {cheapest?.offer && (
            <span className="mr-1.5 text-[15px] text-muted-2 line-through">
              {formatMoney((cheapest.allInOriginal ?? Number(cheapest.offer.originalTotalPrice)) / nights, currency)}
            </span>
          )}
          <span className="font-serif text-[28px] font-semibold">
            {formatMoney(perNight, currency)}
          </span>
          <div className="text-[12px] text-muted-2">{tr.t("perNightInclTaxes")}</div>
        </div>
        {!atMax && remaining <= 5 && (
          <div className="text-[12px] font-medium text-accent">{tr.t("onlyLeft", { n: remaining })}</div>
        )}
        {atMax ? (
          <div className="rounded-[10px] bg-surface-alt py-[11px] text-center text-[13px] font-medium text-muted-2">
            {tr.t("allAvailableAdded", { n: available })}
          </div>
        ) : (
          <Link
            to={detailHref}
            className="w-full rounded-[10px] bg-accent py-[11px] text-center text-[15px] font-semibold text-white transition-colors hover:bg-accent-deep"
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
  party: number;
  currency: string;
  onRemove: (index: number) => void;
  onContinue: () => void;
  continuePending: boolean;
  cartTitle: string;
  continueLabel: string;
  channelId: string;
  qs: string;
  extrasCounts: number[];
  extrasSum: number;
}) {
  const tr = useT();
  return (
    <aside
      className="sticky top-24 w-full min-w-[280px] flex-1 self-start rounded-[18px] border border-line bg-surface p-6"
      style={{ boxShadow: "var(--shadow-sticky)" }}
    >
      <h3 className="mb-1 font-serif text-[21px] font-semibold">{cartTitle}</h3>
      <div className="mb-4 text-[13.5px] text-muted-2">
        {lines.length === 0 ? tr.t("noRoomsSelected") : tr.p("roomsSelected", lines.length)}
      </div>

      {lines.length > 0 && (
        <div className="mb-4 flex flex-col gap-3 border-b border-divider pb-4">
          {lines.map((l, i) => (
            <div key={`${l.roomId}-${l.rateId}-${i}`} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link
                  to={`/${channelId}/rooms/${l.roomId}?edit=${i}&${qs}`}
                  className="group block"
                  title={tr.t("updateRoom")}
                >
                  <div className="truncate text-[14.5px] font-semibold group-hover:text-accent">
                    {l.roomTitle}
                  </div>
                  <div className="text-[12.5px] text-muted-2">
                    {l.rateTitle} · {tr.p("adult", l.occupancy.adults)}
                    {l.occupancy.children ? `, ${tr.p("child", l.occupancy.children)}` : ""}
                    <span className="ml-1 text-[11px] text-accent">✎</span>
                  </div>
                </Link>
                <Link
                  to={`/${channelId}/extras?line=${i}&${qs}`}
                  className="mt-1 inline-block text-[12.5px] font-semibold text-accent hover:underline"
                >
                  {extrasCounts[i] ? tr.t("editExtrasCount", { n: extrasCounts[i] }) : tr.t("addExtras")}
                </Link>
              </div>
              <div className="flex items-center gap-2 whitespace-nowrap">
                <span className="text-[14px] font-semibold">{formatMoney(l.total, currency)}</span>
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  aria-label="Remove room"
                  className="text-[18px] leading-none text-muted-2 hover:text-accent"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div
        className="mb-4 flex items-center gap-2 rounded-[10px] px-3.5 py-2.5 text-[13px] font-semibold"
        style={{
          background: covered ? "#e8f0e6" : "#f5efe5",
          color: covered ? "#3f7a52" : "#857a6c",
        }}
      >
        {covered ? (
          <span className="flex-none text-[14px] leading-none" style={{ color: "#3f7a52" }}>
            ✓
          </span>
        ) : (
          <span
            className="h-[7px] w-[7px] flex-none rounded-[1px] bg-accent"
            style={{ transform: "rotate(45deg)" }}
          />
        )}
        {covered
          ? tr.t("sleepsAll", { n: party })
          : tr.t("sleepsOf", { x: coverage.capacity, y: party })}
      </div>

      {extrasSum > 0 && (
        <div className="mb-2 flex items-baseline justify-between text-[13.5px]">
          <span className="text-secondary">{tr.t("extrasLabel")}</span>
          <span className="font-semibold">{formatMoney(extrasSum, currency)}</span>
        </div>
      )}
      <div className="mb-4 flex items-baseline justify-between">
        <span className="text-[15px] font-semibold">{tr.t("total")}</span>
        <span className="font-serif text-[26px] font-semibold">
          {formatMoney(coverage.total + extrasSum, currency)}
        </span>
      </div>

      <button
        type="button"
        onClick={onContinue}
        disabled={!covered || continuePending}
        className="w-full rounded-[12px] bg-accent py-[14px] text-[16px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-50"
      >
        {continuePending ? tr.t("loading") : continueLabel}
      </button>
    </aside>
  );
}

export default function Results({ loaderData, params }: Route.ComponentProps) {
  const { rooms, nights, bestMatchId, party, cartLines, coverage, covered, extrasSum, text, jsonLd, query } = loaderData;
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
    navigate(`/${params.channelId}/rooms?${next.toString()}`);
  };
  const onContinue = () => {
    setContinuePending(true);
    // Extras are now collected per room during selection, so go straight to checkout.
    navigate(`/${params.channelId}/checkout?${searchParams.toString()}`);
  };

  // Per-line extras count, for the "Edit extras" affordance in the cart.
  const extrasState = parseExtrasState(searchParams);
  const extrasCounts = cart.map((_, i) => extrasState.lines[i]?.length ?? 0);

  const fmt = (d: Date, f: string) => format(d, f, { locale: tr.locale });
  const summary = `${fmt(parseISO(query.checkin), "EEE d")} — ${fmt(
    parseISO(query.checkout),
    "EEE d MMM",
  )} · ${tr.p("night", nights)} · ${occLabel(tr, query.adults, query.childrenAge)}`;

  return (
    <main className="mx-auto max-w-[1160px] px-7 pb-[72px] pt-10">
      {jsonLd && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(jsonLd) }} />
      )}
      <div className="mb-[26px] flex flex-wrap items-end justify-between gap-5">
        <div>
          <h1 className="mb-2 font-serif text-[38px] font-medium tracking-[-0.02em]">
            {text.heading}
          </h1>
          <div className="text-[15px] text-secondary">{summary}</div>
        </div>
        <Link
          to={`/${params.channelId}?${qs}`}
          className="rounded-[10px] border border-line-alt bg-surface-alt px-[18px] py-[11px] text-sm font-semibold text-[#5a5145] hover:border-accent hover:text-accent"
        >
          {text.editSearch}
        </Link>
      </div>

      {rooms.length === 0 ? (
        <p className="text-secondary">
          {tr.t("noAvailability")}{" "}
          <Link to={`/${params.channelId}?${qs}`} className="font-semibold text-accent">
            {tr.t("tryDifferentDates")}
          </Link>
          .
        </p>
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
    </main>
  );
}
