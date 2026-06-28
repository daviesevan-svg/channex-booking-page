import { differenceInCalendarDays, format, parseISO } from "date-fns";

import { isStayBookable } from "~/lib/dates";
import { useState } from "react";
import { Link, redirect, useNavigate, useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/detail";
import type { RoomWithRates } from "~/lib/channex/types";
import { useProperty } from "~/lib/booking-context";
import { getCatalogRooms } from "~/lib/catalog.server";
import { getPageText } from "~/lib/overrides.server";
import { formatMoney } from "~/lib/money";
import { addLine, parseCart, serializeCart } from "~/lib/cart";
import { addExtrasLine, parseExtrasState, serializeExtrasState } from "~/lib/extras";
import { occupancyNightlyDelta } from "~/lib/rate-pricing";
import { cancellationMessage } from "~/lib/cancellation";
import { langFromRequest } from "~/lib/content";
import { useT, type Translator } from "~/lib/i18n";
import { childrenAgeParam, partySize, ratePlansForParty, readOccupancy, roomCapacity } from "~/lib/occupancy";

export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const checkin = url.searchParams.get("checkin");
  const checkout = url.searchParams.get("checkout");
  const currency = url.searchParams.get("currency") || "GBP";
  const { adults, childrenAge } = readOccupancy(url.searchParams);

  if (!checkin || !checkout || !isStayBookable(checkin, checkout)) throw redirect(`/${params.channelId}`);

  const lang = langFromRequest(request);
  const rooms = await getCatalogRooms(
    params.channelId,
    {
      checkinDate: checkin,
      checkoutDate: checkout,
      currency,
      adults,
      childrenAge: childrenAgeParam(childrenAge),
    },
    { gate: true },
  );
  const room = rooms.find((r) => r.id === params.roomId);
  if (!room) throw redirect(`/${params.channelId}/rooms?${url.searchParams.toString()}`);

  const nights = Math.max(1, differenceInCalendarDays(parseISO(checkout), parseISO(checkin)));
  const text = await getPageText(params.channelId, "detail", lang);

  // Per-room occupancy: default this room to the still-unassigned slice of the
  // searched party, so adding a 2nd room auto-fills the remainder. Capacity comes
  // from the room type.
  const { maxAdults, capacity } = roomCapacity(room);
  let assignedAdults = 0;
  const assignedChildren: number[] = [];
  for (const l of parseCart(url.searchParams)) {
    assignedAdults += l.adults ?? adults;
    for (const a of l.childrenAge ?? childrenAge) assignedChildren.push(a);
  }
  const childrenPool = [...childrenAge];
  for (const a of assignedChildren) {
    const i = childrenPool.indexOf(a);
    if (i >= 0) childrenPool.splice(i, 1);
  }
  const defaultAdults = Math.min(maxAdults, Math.max(1, adults - assignedAdults));
  const defaultChildrenCount = Math.min(childrenPool.length, Math.max(0, capacity - defaultAdults));

  return {
    room,
    nights,
    party: partySize({ adults, childrenAge }),
    searched: { adults, childrenAge },
    maxAdults,
    capacity,
    defaultAdults,
    defaultChildrenCount,
    childrenPool,
    text,
    query: { checkin, checkout, currency, adults },
  };
}

function Stepper({
  value,
  min,
  max,
  onDec,
  onInc,
}: {
  value: number;
  min: number;
  max: number;
  onDec: () => void;
  onInc: () => void;
}) {
  const btn =
    "flex h-8 w-8 flex-none items-center justify-center rounded-[8px] border border-line-alt text-[17px] leading-none text-ink disabled:opacity-40 enabled:hover:border-accent enabled:hover:text-accent";
  return (
    <div className="flex items-center gap-3">
      <button type="button" aria-label="Decrease" onClick={onDec} disabled={value <= min} className={btn}>−</button>
      <span className="min-w-[18px] text-center text-[15px] font-semibold">{value}</span>
      <button type="button" aria-label="Increase" onClick={onInc} disabled={value >= max} className={btn}>+</button>
    </div>
  );
}

function rateNote(plan: RoomWithRates["ratePlans"][number], tr: Translator): string {
  const parts: string[] = [];
  if (plan.mealPlan) parts.push(plan.mealPlan);
  if (plan.cancellationNote) {
    parts.push(plan.cancellationNote); // owner override wins
  } else {
    // Derive the cancellation line (incl. the free-cancel deadline) from the policy.
    const msg = cancellationMessage(
      { refundable: plan.refundable ?? true, cancelByISO: plan.freeCancelUntilISO ?? null },
      Date.now(),
    );
    if (msg) parts.push(tr.t(msg.key, "iso" in msg ? { date: format(parseISO(msg.iso), "d MMM", { locale: tr.locale }) } : undefined));
    else if (plan.cancellationPolicy?.title) parts.push(tr.t("cancellationSuffix", { title: plan.cancellationPolicy.title }));
  }
  return parts.join(" · ") || tr.t("standardRate");
}

type DetailRate = RoomWithRates["ratePlans"][number];

export default function Detail({ loaderData, params }: Route.ComponentProps) {
  const { room, nights, party, searched, maxAdults, capacity, defaultAdults, defaultChildrenCount, childrenPool, text, query } = loaderData;
  const { currency } = useProperty();
  const tr = useT();
  const fmt = (d: Date, f: string) => format(d, f, { locale: tr.locale });
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const adding = navigation.state === "loading";
  const qs = searchParams.toString();

  const ratePlans = ratePlansForParty(room, party);
  const [selectedRate, setSelectedRate] = useState(ratePlans[0]?.id);
  const chosen = ratePlans.find((r) => r.id === selectedRate) ?? ratePlans[0];

  // Per-room occupancy the guest is booking (defaults to the unassigned party).
  const [adults, setAdults] = useState(defaultAdults);
  const [childrenCount, setChildrenCount] = useState(defaultChildrenCount);
  const maxChildren = Math.min(childrenPool.length, Math.max(0, capacity - adults));
  const childCount = Math.min(childrenCount, maxChildren);
  const childrenAges = childrenPool.slice(0, childCount);
  const hasChildrenChoice = childrenPool.length > 0;

  // Live price for a rate plan at the selected occupancy. The occupancy delta is
  // flat per night, so reverse out the searched-party delta to get the zero-delta
  // base, then re-apply for this room's party. The server re-prices identically.
  const priceFor = (plan: DetailRate) => {
    const op = plan.occupancyPricing;
    const grossSearched = plan.offer ? Number(plan.offer.originalTotalPrice) : Number(plan.totalPrice);
    const baseGross = grossSearched - occupancyNightlyDelta(op, searched.adults, searched.childrenAge) * nights;
    const gross = Math.max(0, baseGross + occupancyNightlyDelta(op, adults, childrenAges) * nights);
    const offerPct = plan.offer?.percent ?? 0;
    return {
      gross: Math.round(gross * 100) / 100,
      sale: Math.round(gross * (1 - offerPct / 100) * 100) / 100,
      hasOffer: offerPct > 0,
    };
  };
  const chosenPrice = chosen ? priceFor(chosen) : { gross: 0, sale: 0, hasOffer: false };

  const summary = `${tr.p("night", nights)} · ${fmt(parseISO(query.checkin), "EEE d")} — ${fmt(
    parseISO(query.checkout),
    "EEE d MMM",
  )}`;

  const ratePhotos = (chosen?.images ?? []).map((url) => ({ url }));
  const galleryPhotos = [...ratePhotos, ...(room.photos ?? [])];
  const hero = galleryPhotos[0]?.url;
  const thumbs = galleryPhotos.slice(1, 3);
  const amenities = room.facilities ?? [];

  function addToStay() {
    if (!chosen) return;
    const lines = addLine(parseCart(searchParams), {
      roomId: room.id,
      rateId: chosen.id,
      adults,
      childrenAge: childrenAges.length ? childrenAges : undefined,
    });
    const newIndex = lines.length - 1;
    // Keep the per-line extras buckets aligned with the cart, then send the guest
    // to that room's "enhance" step (it redirects straight to results if there's
    // nothing to offer for this room).
    const state = addExtrasLine(parseExtrasState(searchParams));
    const next = new URLSearchParams(searchParams);
    next.set("sel", serializeCart(lines));
    const xt = serializeExtrasState(state);
    if (xt) next.set("xt", xt);
    else next.delete("xt");
    navigate(`/${params.channelId}/extras?line=${newIndex}&${next.toString()}`);
  }

  const stripe = "repeating-linear-gradient(135deg,#efe7da,#efe7da 12px,#e7ddcc 12px,#e7ddcc 24px)";

  return (
    <main className="mx-auto max-w-[1160px] px-7 pb-[72px] pt-7">
      <Link
        to={`/${params.channelId}/rooms?${qs}`}
        className="mb-5 inline-block text-sm font-semibold text-muted hover:text-accent"
      >
        ← {text.backLink}
      </Link>

      {/* gallery */}
      <div className="mb-7 flex h-[380px] gap-3">
        <div className="flex-[2] overflow-hidden rounded-[16px]" style={{ background: stripe }}>
          {hero && <img src={hero} alt={room.title} className="h-full w-full object-cover" />}
        </div>
        <div className="flex flex-1 flex-col gap-3">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="flex-1 overflow-hidden rounded-[16px]"
              style={{ background: stripe }}
            >
              {thumbs[i] && (
                <img src={thumbs[i].url} alt="" className="h-full w-full object-cover" />
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-10">
        <div className="min-w-[320px] flex-[1.6]">
          <h1 className="mb-2 font-serif text-[40px] font-medium tracking-[-0.02em]">
            {room.title}
          </h1>
          {room.description && (
            <p className="mb-7 max-w-[560px] text-[17px] leading-[1.65] text-[#5e5547]">
              {room.description}
            </p>
          )}
          {amenities.length > 0 && (
            <>
              <h3 className="mb-4 font-serif text-[20px] font-semibold">{text.amenitiesTitle}</h3>
              <div className="grid max-w-[520px] grid-cols-1 gap-x-7 gap-y-3 sm:grid-cols-2">
                {amenities.map((a) => (
                  <div key={a} className="flex items-center gap-3 text-[15px] text-[#4a4236]">
                    <span
                      className="h-[7px] w-[7px] flex-none rounded-[1px] bg-accent"
                      style={{ transform: "rotate(45deg)" }}
                    />
                    {a}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* rate card */}
        <div
          className="sticky top-24 min-w-[320px] flex-1 rounded-[18px] border border-line bg-surface p-6"
          style={{ boxShadow: "var(--shadow-sticky)" }}
        >
          <h3 className="mb-1 font-serif text-[21px] font-semibold">{text.rateTitle}</h3>
          <div className="mb-4 text-[13.5px] text-muted-2">{summary}</div>

          {/* Per-room occupancy — book this room for a specific party. */}
          <div className="mb-5 rounded-[12px] border border-line-alt bg-surface-alt/40 p-3.5">
            <div className="mb-2.5 text-[12px] font-semibold uppercase tracking-wide text-muted-2">
              {tr.t("guests")}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[14px] font-medium text-secondary">{tr.t("adults")}</span>
              <Stepper
                value={adults}
                min={1}
                max={maxAdults}
                onDec={() => setAdults((a) => Math.max(1, a - 1))}
                onInc={() => setAdults((a) => Math.min(maxAdults, a + 1))}
              />
            </div>
            {hasChildrenChoice && (
              <div className="mt-2.5 flex items-center justify-between">
                <span className="text-[14px] font-medium text-secondary">{tr.t("children")}</span>
                <Stepper
                  value={childCount}
                  min={0}
                  max={maxChildren}
                  onDec={() => setChildrenCount((c) => Math.max(0, c - 1))}
                  onInc={() => setChildrenCount((c) => Math.min(maxChildren, c + 1))}
                />
              </div>
            )}
            <div className="mt-2.5 text-[11.5px] text-faint">{tr.t("sleeps", { n: capacity })}</div>
          </div>

          <div className="mb-5 flex flex-col gap-2.5">
            {ratePlans.map((plan) => {
              const active = plan.id === chosen?.id;
              const pr = priceFor(plan);
              const perNight = pr.sale / nights;
              return (
                <button
                  key={plan.id}
                  type="button"
                  onClick={() => setSelectedRate(plan.id)}
                  className="flex items-start gap-3 rounded-[12px] border-[1.5px] p-4 text-left transition-colors"
                  style={{
                    borderColor: active ? "var(--accent)" : "#e8e0d5",
                    background: active ? "var(--accent-soft)" : "#fff",
                  }}
                >
                  <span
                    className="mt-0.5 h-[18px] w-[18px] flex-none rounded-full border-2"
                    style={{
                      borderColor: active ? "var(--accent)" : "#cfc4b2",
                      background: active ? "var(--accent)" : "transparent",
                    }}
                  />
                  <span className="flex-1">
                    <span className="flex items-baseline justify-between gap-2.5">
                      <span className="text-[15.5px] font-semibold">
                        {plan.title}
                        {plan.offer && (
                          <span className="ml-2 rounded-full bg-[#ece6f0] px-2 py-0.5 align-middle text-[11px] font-semibold text-[#6b4f8a]">
                            {plan.offer.name} −{plan.offer.percent}%
                          </span>
                        )}
                      </span>
                      <span className="whitespace-nowrap text-[15.5px] font-semibold">
                        {pr.hasOffer && (
                          <span className="mr-1.5 text-[13px] font-normal text-muted-2 line-through">
                            {formatMoney(pr.gross / nights, currency)}
                          </span>
                        )}
                        {formatMoney(perNight, currency)} {tr.t("perNight")}
                      </span>
                    </span>
                    <span className="mt-1 block text-[13px] leading-[1.45] text-muted">
                      {rateNote(plan, tr)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {(chosen?.description || chosen?.inclusions?.length) && (
            <div className="mb-4 rounded-[12px] bg-[#faf6ef] p-4">
              {chosen?.description && (
                <p className="text-[13.5px] leading-[1.55] text-[#5e5547]">{chosen.description}</p>
              )}
              {chosen?.inclusions?.length ? (
                <>
                  <div
                    className={`mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-2 ${
                      chosen?.description ? "mt-3" : ""
                    }`}
                  >
                    {tr.t("whatsIncluded")}
                  </div>
                  <ul className="flex flex-col gap-1.5">
                    {chosen.inclusions.map((inc, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 text-[13.5px] text-[#4a4236]"
                      >
                        <span
                          className="mt-[6px] h-[6px] w-[6px] flex-none rounded-[1px] bg-accent"
                          style={{ transform: "rotate(45deg)" }}
                        />
                        {inc}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          )}
          <div className="mb-4 flex items-baseline justify-between border-t border-divider pt-4">
            <span className="text-sm text-secondary">
              {tr.t("totalNights", { n: nights })}
            </span>
            <span className="font-serif text-[28px] font-semibold">
              {chosen ? (
                <>
                  {chosenPrice.hasOffer && (
                    <span className="mr-2 text-[18px] font-normal text-muted-2 line-through">
                      {formatMoney(chosenPrice.gross, currency)}
                    </span>
                  )}
                  {formatMoney(chosenPrice.sale, currency)}
                </>
              ) : (
                "—"
              )}
            </span>
          </div>
          <button
            type="button"
            onClick={addToStay}
            disabled={adding}
            className="w-full rounded-[12px] bg-accent py-[15px] text-[16px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:opacity-70"
          >
            {adding ? "Adding…" : text.addButton}
          </button>
        </div>
      </div>
    </main>
  );
}
