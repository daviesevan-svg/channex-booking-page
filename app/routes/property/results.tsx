import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { useEffect, useState } from "react";
import { Link, redirect, useNavigate, useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/results";
import type { RoomWithRates } from "~/lib/channex/types";
import { useProperty } from "~/lib/booking-context";
import {
  cartCoverage,
  cartCovers,
  parseCart,
  removeIndex,
  resolveCart,
  roomCounts,
  serializeCart,
  type ResolvedLine,
} from "~/lib/cart";
import { getCatalogRooms } from "~/lib/catalog.server";
import { getPageText } from "~/lib/overrides.server";
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
  const currency = url.searchParams.get("currency") || "GBP";
  const occ = readOccupancy(url.searchParams);
  const lang = langFromRequest(request);

  if (!checkin || !checkout) {
    throw redirect(`/${params.channelId}`);
  }

  const rooms = await getCatalogRooms(
    params.channelId,
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
  const text = await getPageText(params.channelId, "results", lang);

  const cartLines = resolveCart(parseCart(url.searchParams), rooms);
  const coverage = cartCoverage(cartLines);
  const covered = cartCovers(cartLines, occ);

  return {
    rooms: enriched,
    nights,
    bestMatchId,
    party: partySize(occ),
    cartLines,
    coverage,
    covered,
    text,
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
  const perNight = cheapest ? Number(cheapest.totalPrice) / nights : 0;
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
        <div>
          <span className="text-[13px] text-muted-2">{tr.t("from")} </span>
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
                <div className="truncate text-[14.5px] font-semibold">{l.roomTitle}</div>
                <div className="text-[12.5px] text-muted-2">
                  {l.rateTitle} · {tr.p("adult", l.occupancy.adults)}
                  {l.occupancy.children ? `, ${tr.p("child", l.occupancy.children)}` : ""}
                </div>
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

      <div className="mb-4 flex items-baseline justify-between">
        <span className="text-[15px] font-semibold">{tr.t("total")}</span>
        <span className="font-serif text-[26px] font-semibold">
          {formatMoney(coverage.total, currency)}
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
  const { rooms, nights, bestMatchId, party, cartLines, coverage, covered, text, query } = loaderData;
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

  function go(sel: string) {
    const next = new URLSearchParams(searchParams);
    if (sel) next.set("sel", sel);
    else next.delete("sel");
    navigate(`/${params.channelId}/rooms?${next.toString()}`);
  }
  const onRemove = (index: number) => go(serializeCart(removeIndex(cart, index)));
  const onContinue = () => {
    setContinuePending(true);
    navigate(`/${params.channelId}/checkout?${searchParams.toString()}`);
  };

  const fmt = (d: Date, f: string) => format(d, f, { locale: tr.locale });
  const summary = `${fmt(parseISO(query.checkin), "EEE d")} — ${fmt(
    parseISO(query.checkout),
    "EEE d MMM",
  )} · ${tr.p("night", nights)} · ${occLabel(tr, query.adults, query.childrenAge)}`;

  return (
    <main className="mx-auto max-w-[1160px] px-7 pb-[72px] pt-10">
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
            />
          </div>
        </div>
      )}
    </main>
  );
}
