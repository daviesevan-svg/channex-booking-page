import { differenceInCalendarDays, format, parseISO } from "date-fns";

import { isStayBookable, isTooLastMinute } from "~/lib/dates";
import { useEffect, useState } from "react";
import { Link, redirect, useNavigate, useNavigation, useSearchParams } from "react-router";
import { jsonLdHtml } from "~/lib/jsonld";

import type { Route } from "./+types/detail";
import type { RoomWithRates } from "~/lib/channex/types";
import { useProperty } from "~/lib/booking-context";
import { getCatalogRooms } from "~/lib/catalog.server";
import { catalogHotelJsonLd } from "~/lib/hotel-jsonld.server";
import { getBookingCutoff, getPageText, getSettings } from "~/lib/overrides.server";
import { resolvePropertyId } from "~/lib/properties.server";
import { computePricing, taxConfigFrom } from "~/lib/pricing";
import { formatMoney } from "~/lib/money";
import { addLine, lineOccupancy, parseCart, replaceIndex, serializeCart } from "~/lib/cart";
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
  const { adults, childrenAge } = readOccupancy(url.searchParams);
  // :channelId may be a slug — resolve to the real id for data lookups; redirects
  // and links keep params.channelId so the slug stays in the URL.
  const pid = await resolvePropertyId(params.channelId);

  if (!checkin || !checkout || !isStayBookable(checkin, checkout)) throw redirect(`/${params.channelId}`);
  if (isTooLastMinute(checkin, await getBookingCutoff(pid))) throw redirect(`/${params.channelId}`);

  // Currency is the property's, not the URL param (no conversion exists).
  const settings = await getSettings(pid);
  const currency = settings.currency || "GBP";

  const lang = langFromRequest(request);
  const rooms = await getCatalogRooms(
    pid,
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
  // Single-unit properties auto-forward /rooms → here, so a not-found bounce must
  // go to the landing (not back to /rooms) or the two would redirect in a loop.
  if (!room)
    throw redirect(
      settings.singleUnit
        ? `/${params.channelId}?${url.searchParams.toString()}`
        : `/${params.channelId}/rooms?${url.searchParams.toString()}`,
    );

  const nights = Math.max(1, differenceInCalendarDays(parseISO(checkout), parseISO(checkin)));
  const text = await getPageText(pid, "detail", lang);

  // Per-room occupancy: default this room to the still-unassigned slice of the
  // searched party, so adding a 2nd room auto-fills the remainder. Capacity comes
  // from the room type.
  const { maxAdults, capacity } = roomCapacity(room);
  const cart = parseCart(url.searchParams);
  // Edit mode: the guest clicked an already-selected room to change it. Valid
  // only when the index exists and points at THIS room.
  const editRaw = url.searchParams.get("edit");
  const editIndex =
    editRaw != null && /^\d+$/.test(editRaw) && cart[Number(editRaw)]?.roomId === params.roomId
      ? Number(editRaw)
      : null;
  const editLine = editIndex != null ? cart[editIndex] : null;

  let assignedAdults = 0;
  const assignedChildren: number[] = [];
  cart.forEach((l, idx) => {
    if (idx === editIndex) return; // re-choosing this line — don't count it as already assigned
    const o = lineOccupancy(l, { adults, childrenAge });
    assignedAdults += o.adults;
    for (const a of o.childrenAge) assignedChildren.push(a);
  });
  const childrenPool = [...childrenAge];
  for (const a of assignedChildren) {
    const i = childrenPool.indexOf(a);
    if (i >= 0) childrenPool.splice(i, 1);
  }
  // Editing: pre-fill from the line's current occupancy. Otherwise: the still-
  // unassigned slice of the searched party.
  const defaultAdults = editLine
    ? Math.min(maxAdults, Math.max(1, editLine.adults ?? adults))
    : Math.min(maxAdults, Math.max(1, adults - assignedAdults));
  const defaultChildrenCount = editLine
    ? Math.min(childrenPool.length, editLine.childrenAge?.length ?? 0)
    : Math.min(childrenPool.length, Math.max(0, capacity - defaultAdults));

  const party = partySize({ adults, childrenAge });
  // All-in (tax-/fee-inclusive) price for the searched party — matches the headline
  // shown to the guest and the checkout total. Also passed to the client so the
  // live occupancy re-price stays all-in.
  const taxConfig = taxConfigFrom(settings);
  const allIn = (base: number) =>
    Math.round(
      computePricing(
        { base, nights, adults, children: childrenAge.length, rooms: 1, cleaningFee: room.cleaningFee ?? 0, taxableExtras: 0, checkin },
        taxConfig,
      ).total * 100,
    ) / 100;
  // Google Hotel price structured data — this room and its rate plans, all-in.
  const jsonLd = await catalogHotelJsonLd(pid, lang, { checkin, checkout }, [
    {
      roomId: room.id,
      name: room.title,
      occupancy: capacity,
      image: room.photos?.[0]?.url,
      offers: ratePlansForParty(room, party).map((rp) => ({
        rateId: rp.parentRatePlanId ?? rp.id,
        total: allIn(Number(rp.totalPrice)),
      })),
    },
  ]);

  return {
    room,
    nights,
    party,
    jsonLd,
    taxConfig,
    cleaningFee: room.cleaningFee ?? 0,
    searched: { adults, childrenAge },
    maxAdults,
    capacity,
    defaultAdults,
    defaultChildrenCount,
    childrenPool,
    editIndex,
    editRateId: editLine?.rateId ?? null,
    text,
    singleUnit: settings.singleUnit ?? false,
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
  const { room, nights, party, searched, maxAdults, capacity, defaultAdults, defaultChildrenCount, childrenPool, editIndex, editRateId, text, jsonLd, taxConfig, cleaningFee, singleUnit, query } = loaderData;
  const { currency } = useProperty();
  const tr = useT();
  const fmt = (d: Date, f: string) => format(d, f, { locale: tr.locale });
  // Full-screen photo viewer; null = closed, otherwise the galleryPhotos index.
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const adding = navigation.state === "loading";
  const qs = searchParams.toString();

  const ratePlans = ratePlansForParty(room, party);
  // When editing an existing selection, pre-select its rate (match by id or the
  // stable parent rate id); otherwise the first rate.
  const initialRate =
    (editRateId && ratePlans.find((r) => r.id === editRateId || r.parentRatePlanId === editRateId)?.id) ||
    ratePlans[0]?.id;
  const [selectedRate, setSelectedRate] = useState(initialRate);
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
  // Tax-/fee-inclusive (all-in) total for a room base at the live occupancy, so
  // the displayed price matches the checkout total. Uses the same computePricing
  // the checkout and results loader use.
  const allInOf = (base: number) =>
    Math.round(
      computePricing(
        { base, nights, adults, children: childrenAges.length, rooms: 1, cleaningFee, taxableExtras: 0, checkin: query.checkin },
        taxConfig,
      ).total * 100,
    ) / 100;
  const priceFor = (plan: DetailRate) => {
    const op = plan.occupancyPricing;
    const grossSearched = plan.offer ? Number(plan.offer.originalTotalPrice) : Number(plan.totalPrice);
    const baseGross = grossSearched - occupancyNightlyDelta(op, searched.adults, searched.childrenAge) * nights;
    const gross = Math.max(0, baseGross + occupancyNightlyDelta(op, adults, childrenAges) * nights);
    const offerPct = plan.offer?.percent ?? 0;
    return {
      gross: allInOf(gross),
      sale: allInOf(gross * (1 - offerPct / 100)),
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
  // Structured amenities (translated) first, then the host's free-text extras.
  const amenities = [
    ...(room.amenities ?? []).map((k) => tr.t(`am_${k}`)),
    ...(room.facilities ?? []),
  ];

  function addToStay() {
    if (!chosen) return;
    const cart = parseCart(searchParams);
    const line = {
      roomId: room.id,
      rateId: chosen.id,
      adults,
      childrenAge: childrenAges.length ? childrenAges : undefined,
    };
    // Editing replaces the line in place (keeping its extras bucket); a fresh
    // selection appends and opens a new extras bucket.
    const lines = editIndex != null ? replaceIndex(cart, editIndex, line) : addLine(cart, line);
    const targetIndex = editIndex ?? lines.length - 1;
    const state = editIndex != null ? parseExtrasState(searchParams) : addExtrasLine(parseExtrasState(searchParams));
    const next = new URLSearchParams(searchParams);
    next.delete("edit");
    next.set("sel", serializeCart(lines));
    const xt = serializeExtrasState(state);
    if (xt) next.set("xt", xt);
    else next.delete("xt");
    // The extras step redirects straight to results when the room has no add-ons.
    navigate(`/${params.channelId}/extras?line=${targetIndex}&${next.toString()}`);
  }

  const stripe = "repeating-linear-gradient(135deg,#efe7da,#efe7da 12px,#e7ddcc 12px,#e7ddcc 24px)";

  return (
    <main className="mx-auto max-w-[1160px] px-7 pb-[72px] pt-7">
      {jsonLd && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(jsonLd) }} />
      )}
      <Link
        to={singleUnit ? `/${params.channelId}?${qs}` : `/${params.channelId}/rooms?${qs}`}
        className="mb-5 inline-block text-sm font-semibold text-muted hover:text-accent"
      >
        ← {text.backLink}
      </Link>

      {/* gallery — click any photo to open the full-screen viewer */}
      <div className="mb-7 flex h-[380px] gap-3">
        <button
          type="button"
          onClick={() => hero && setLightbox(0)}
          disabled={!hero}
          aria-label={tr.t("viewAllPhotos")}
          className="group relative flex-[2] overflow-hidden rounded-[16px] disabled:cursor-default"
          style={{ background: stripe }}
        >
          {hero && (
            <img
              src={hero}
              alt={room.title}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
            />
          )}
          {galleryPhotos.length > 1 && (
            <span className="pointer-events-none absolute bottom-4 left-4 inline-flex items-center gap-2 rounded-full bg-black/55 px-4 py-2 text-[13px] font-semibold text-white backdrop-blur-sm">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="m21 15-5-5L5 21" />
              </svg>
              {tr.t("viewAllPhotos")} · {galleryPhotos.length}
            </span>
          )}
        </button>
        <div className="flex flex-1 flex-col gap-3">
          {[0, 1].map((i) => {
            const more = galleryPhotos.length - 3;
            return (
              <button
                key={i}
                type="button"
                onClick={() => thumbs[i] && setLightbox(i + 1)}
                disabled={!thumbs[i]}
                aria-label={tr.t("viewAllPhotos")}
                className="group relative flex-1 overflow-hidden rounded-[16px] disabled:cursor-default"
                style={{ background: stripe }}
              >
                {thumbs[i] && (
                  <img
                    src={thumbs[i].url}
                    alt=""
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                  />
                )}
                {i === 1 && more > 0 && thumbs[i] && (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-[19px] font-semibold text-white">
                    +{more}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <Lightbox photos={galleryPhotos} index={lightbox} title={room.title} tr={tr} onChange={setLightbox} onClose={() => setLightbox(null)} />

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
            <div className="mt-2.5 text-[11.5px] text-faint">
              {tr.t("sleeps", { n: capacity })}
              {capacity > maxAdults && (
                <> · {tr.p("adult", maxAdults)} + {tr.p("child", capacity - maxAdults)}</>
              )}
            </div>
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
                    <span className="flex items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block text-[15.5px] font-semibold">{plan.title}</span>
                        {plan.offer && (
                          <span className="mt-1 inline-block rounded-full bg-[#ece6f0] px-2 py-0.5 text-[11px] font-semibold text-[#6b4f8a]">
                            {plan.offer.name} −{plan.offer.percent}%
                          </span>
                        )}
                      </span>
                      <span className="flex-none text-right">
                        <span className="block whitespace-nowrap text-[15.5px] font-semibold">
                          {pr.hasOffer && (
                            <span className="mr-1.5 text-[13px] font-normal text-muted-2 line-through">
                              {formatMoney(pr.gross / nights, currency)}
                            </span>
                          )}
                          {formatMoney(perNight, currency)}
                        </span>
                        <span className="block text-[11.5px] text-muted-2">{tr.t("perNightInclTaxes")}</span>
                      </span>
                    </span>
                    <span className="mt-1.5 block text-[13px] leading-[1.45] text-muted">
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
            {adding ? "…" : editIndex != null ? tr.t("updateRoom") : text.addButton}
          </button>
        </div>
      </div>
    </main>
  );
}

/** Full-screen photo viewer: one large image with prev/next, a counter, and
 *  close (× button, backdrop click, or Escape). Arrow keys page through. */
function Lightbox({
  photos,
  index,
  title,
  tr,
  onChange,
  onClose,
}: {
  photos: { url: string }[];
  index: number | null;
  title: string;
  tr: Translator;
  onChange: (i: number) => void;
  onClose: () => void;
}) {
  const total = photos.length;
  useEffect(() => {
    if (index == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") onChange((index + 1) % total);
      else if (e.key === "ArrowLeft") onChange((index - 1 + total) % total);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, total, onChange, onClose]);
  if (index == null || total === 0) return null;

  const arrow =
    "absolute top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/12 text-3xl leading-none text-white hover:bg-white/25";
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={tr.t("viewAllPhotos")}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute right-4 top-4 flex h-11 w-11 items-center justify-center rounded-full bg-white/12 text-2xl leading-none text-white hover:bg-white/25"
      >
        ×
      </button>
      {total > 1 && (
        <button
          type="button"
          aria-label="Previous"
          onClick={(e) => {
            e.stopPropagation();
            onChange((index - 1 + total) % total);
          }}
          className={`${arrow} left-4`}
        >
          ‹
        </button>
      )}
      <figure onClick={(e) => e.stopPropagation()} className="flex max-h-full flex-col items-center">
        <img
          src={photos[index].url}
          alt={title}
          className="max-h-[82vh] w-auto max-w-full rounded-[12px] object-contain"
        />
        {total > 1 && (
          <figcaption className="mt-3 text-[13px] text-white/70">
            {index + 1} / {total}
          </figcaption>
        )}
      </figure>
      {total > 1 && (
        <button
          type="button"
          aria-label="Next"
          onClick={(e) => {
            e.stopPropagation();
            onChange((index + 1) % total);
          }}
          className={`${arrow} right-4`}
        >
          ›
        </button>
      )}
    </div>
  );
}
