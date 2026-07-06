import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import type { Route } from "./+types/collection.$collectionSlug";
import { CalendarPopover } from "~/components/calendar-popover";
import { GuestSelector } from "~/components/guest-selector";
import { getCollectionBySlug } from "~/lib/collections.server";
import { getCatalogRooms } from "~/lib/catalog.server";
import { getConfig } from "~/lib/config.server";
import {
  DEFAULT_THEME,
  fontPair,
  langFromRequest,
} from "~/lib/content";
import { makeTranslator } from "~/lib/i18n";
import { formatMoney } from "~/lib/money";
import {
  childrenAgeParam,
  type Occupancy,
  partySize,
  ratePlansForParty,
  readOccupancy,
  writeOccupancy,
} from "~/lib/occupancy";
import { getOverrides, getSettings } from "~/lib/overrides.server";
import { getProperties } from "~/lib/properties.server";
import { computePricing, taxConfigFrom } from "~/lib/pricing";
import { isStayBookable } from "~/lib/dates";
import { useDateRange } from "~/lib/use-date-range";

type PropView = {
  urlSeg: string;
  name: string;
  area: string;
  typeLabel: string;
  photo: string | null;
  chips: string[];
  fromPrice: string | null;
  fromPriceNum: number | null; // numeric all-in nightly, for sorting
  soldOut: boolean;
  currency: string;
  lat: number | null; // real coordinates for the Google map (null when unset)
  lng: number | null;
  left: number | null; // pin x %, null when no coordinates — stylized-map fallback only
  top: number | null; // pin y %
};

export async function loader({ params, request }: Route.LoaderArgs) {
  const collection = await getCollectionBySlug(params.collectionSlug);
  if (!collection) throw new Response("Not Found", { status: 404 });

  const lang = langFromRequest(request);
  const url = new URL(request.url);
  const checkin = url.searchParams.get("checkin");
  const checkout = url.searchParams.get("checkout");
  const occ = readOccupancy(url.searchParams);
  const hasDates = Boolean(checkin && checkout && isStayBookable(checkin, checkout));
  const nights = hasDates
    ? Math.max(1, differenceInCalendarDays(parseISO(checkout!), parseISO(checkin!)))
    : 0;
  const party = partySize(occ);

  // Map property ids → registry ref (for the pretty URL segment / name fallback).
  const registry = new Map((await getProperties()).map((p) => [p.id, p]));

  // Build a view-model per member property. When dates are set, price each one
  // live from its own inventory (this is the cross-property availability the
  // collection promises — one gated catalog read per property, in parallel).
  const raw = await Promise.all(
    collection.propertyIds.map(async (pid) => {
      const ref = registry.get(pid);
      if (!ref) return null; // removed property — skip
      const [settings, overrides] = await Promise.all([getSettings(pid), getOverrides(pid, lang)]);
      const currency = settings.currency || "GBP";
      const lat = parseFloat(settings.latitude ?? "");
      const lng = parseFloat(settings.longitude ?? "");

      // The property's own cover photo is the image — shown even before a date
      // search. Falls back to the cheapest room's photo when no cover is set.
      let photo: string | null = settings.coverImage || null;
      let chips: string[] = [];
      let fromPrice: string | null = null;
      let fromPriceNum: number | null = null;
      let soldOut = false;

      if (hasDates) {
        const rooms = await getCatalogRooms(
          pid,
          {
            checkinDate: checkin!,
            checkoutDate: checkout!,
            currency,
            adults: occ.adults,
            childrenAge: childrenAgeParam(occ.childrenAge),
          },
          { gate: true },
        ).catch(() => []);
        soldOut = rooms.length === 0;
        const taxConfig = taxConfigFrom(settings);
        let cheapest = Infinity;
        let cheapestRoom: (typeof rooms)[number] | null = null;
        for (const room of rooms) {
          for (const rp of ratePlansForParty(room, party)) {
            const allIn =
              computePricing(
                {
                  base: Number(rp.totalPrice),
                  nights,
                  adults: occ.adults,
                  children: occ.childrenAge.length,
                  rooms: 1,
                  cleaningFee: room.cleaningFee ?? 0,
                  taxableExtras: 0,
                },
                taxConfig,
              ).total / nights;
            if (allIn < cheapest) {
              cheapest = allIn;
              cheapestRoom = room;
            }
          }
        }
        if (cheapestRoom) {
          if (!photo) photo = cheapestRoom.photos?.[0]?.url ?? null;
          chips = (cheapestRoom.facilities ?? []).slice(0, 3);
          fromPrice = formatMoney(cheapest, currency);
          fromPriceNum = cheapest;
        }
      }

      return {
        pid,
        ref,
        currency,
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        view: {
          urlSeg: ref.slug || pid,
          name: overrides.hotelName || ref.name,
          area: settings.addressCity || settings.addressRegion || "",
          typeLabel: overrides.propertyType || (settings.singleUnit ? "Apartment" : "Hotel"),
          photo,
          chips,
          fromPrice,
          fromPriceNum,
          soldOut,
          currency,
          lat: Number.isFinite(lat) ? lat : null,
          lng: Number.isFinite(lng) ? lng : null,
        },
      };
    }),
  );
  const items = raw.filter((x): x is NonNullable<typeof x> => x !== null);

  // Normalise real lat/lng into pin positions on the styled map (12%–88% box, so
  // pins never hug the edge). Properties without coordinates get no pin.
  const geo = items.filter((i) => i.lat != null && i.lng != null);
  const lats = geo.map((g) => g.lat as number);
  const lngs = geo.map((g) => g.lng as number);
  const minLat = Math.min(...lats),
    maxLat = Math.max(...lats),
    minLng = Math.min(...lngs),
    maxLng = Math.max(...lngs);
  const spanLat = maxLat - minLat || 1,
    spanLng = maxLng - minLng || 1;

  const properties: PropView[] = items.map((i) => {
    let left: number | null = null;
    let top: number | null = null;
    if (i.lat != null && i.lng != null) {
      left = geo.length === 1 ? 50 : 12 + ((i.lng - minLng) / spanLng) * 76;
      top = geo.length === 1 ? 50 : 12 + ((maxLat - i.lat) / spanLat) * 76; // invert: north = top
    }
    return { ...i.view, left, top };
  });

  const availableCount = hasDates ? properties.filter((p) => !p.soldOut).length : properties.length;

  return {
    name: collection.name,
    destination: collection.destination || "",
    heading: collection.heading || "", // blank → localized default in the component
    intro: collection.intro || "",
    phone: collection.phone || "",
    theme: collection.theme ?? DEFAULT_THEME,
    customColor: collection.customColor,
    customBg: collection.customBg,
    themeFont: collection.themeFont,
    properties,
    hasDates,
    nights,
    checkin: checkin ?? "",
    checkout: checkout ?? "",
    occ,
    availableCount,
    lang,
    mapKey: getConfig().googleMapKey ?? "",
  };
}

export function headers() {
  return { "Cache-Control": "private, no-store" }; // per-date availability isn't cacheable
}

export function meta() {
  return [{ title: "Choose where you'll stay" }];
}

function Diamond({ size = 8 }: { size?: number }) {
  return (
    <span
      className="inline-block flex-none rounded-[1px] bg-accent"
      style={{ width: size, height: size, transform: "rotate(45deg)" }}
    />
  );
}

const HATCH =
  "repeating-linear-gradient(135deg,#efe7da,#efe7da 11px,#e7ddcc 11px,#e7ddcc 22px)";

export default function CollectionPage({ loaderData }: Route.ComponentProps) {
  const {
    name,
    destination,
    heading,
    intro,
    phone,
    theme,
    customColor,
    customBg,
    themeFont,
    properties,
    hasDates,
    nights,
    checkin,
    checkout,
    occ,
    availableCount,
    lang,
    mapKey,
  } = loaderData;

  const tr = makeTranslator(lang);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingDates, setEditingDates] = useState(false);
  const [sort, setSort] = useState<"asc" | "desc">("asc"); // cheapest first by default

  // Sort a copy for the list; sold-out / unpriced always sink to the bottom.
  // Pins keep the original set (order is irrelevant — they're positioned by geo).
  const listProps = [...properties].sort((a, b) => {
    if (a.fromPriceNum == null && b.fromPriceNum == null) return 0;
    if (a.fromPriceNum == null) return 1;
    if (b.fromPriceNum == null) return -1;
    return sort === "asc" ? a.fromPriceNum - b.fromPriceNum : b.fromPriceNum - a.fromPriceNum;
  });

  // Date/guest editor (reused from the booking flow; no cross-property closed
  // dates — availability is enforced per property once the guest clicks in).
  const dates = useDateRangeSafe(checkin, checkout, tr);
  const [occupancy, setOccupancy] = useState<Occupancy>(occ);

  const applyDates = () => {
    if (!dates.checkinIso || !dates.checkoutIso) return;
    const qs = writeOccupancy(
      new URLSearchParams({ checkin: dates.checkinIso, checkout: dates.checkoutIso }),
      occupancy,
    );
    setEditingDates(false); // collapse the editor once a search is submitted
    dates.setOpen?.(false);
    navigate(`?${qs.toString()}`);
  };

  const goToProperty = (p: (typeof properties)[number]) => {
    if (p.soldOut) return;
    const base = `/${p.urlSeg}`;
    if (!hasDates) return navigate(base);
    const qs = writeOccupancy(
      new URLSearchParams({ checkin, checkout }),
      occupancy,
    );
    navigate(`${base}/rooms?${qs.toString()}`);
  };

  const clickPin = (id: string) => {
    setActiveId((cur) => (cur === id ? null : id));
    setHoveredId(id);
    const el = document.getElementById(`prop-${id}`);
    if (el) {
      const r = el.getBoundingClientRect();
      window.scrollTo({ top: r.top + window.scrollY - 148, behavior: "smooth" });
    }
  };

  const isCustom = theme === "custom" && !!customColor;
  const font = fontPair(themeFont);
  const themeStyle = { background: "#f7f2ec" } as React.CSSProperties;
  if (isCustom) {
    Object.assign(themeStyle, {
      "--accent": customColor,
      "--accent-deep": `color-mix(in oklab, ${customColor} 82%, black)`,
      "--page": customBg || "#f7f2ec",
    });
    if (customBg) themeStyle.background = customBg;
  }
  if (font.id !== "default") {
    Object.assign(themeStyle, { "--font-serif": font.heading, "--font-sans": font.body });
  }

  const datesLabel = hasDates
    ? `${format(parseISO(checkin), "EEE d", { locale: tr.locale })} — ${format(parseISO(checkout), "EEE d MMM", {
        locale: tr.locale,
      })} · ${tr.p("night", nights)} · ${tr.p("adult", occ.adults)}`
    : tr.t("selectYourDates");

  return (
    <div
      className="min-h-screen font-sans text-ink"
      data-theme={isCustom ? undefined : theme}
      style={themeStyle}
    >
      {font.href && <link rel="stylesheet" href={font.href} />}

      {/* header */}
      <header
        className="sticky top-0 z-50 border-b"
        style={{ background: "rgba(247,242,236,0.85)", backdropFilter: "blur(10px)", borderColor: "#ece4d8" }}
      >
        <div className="mx-auto flex max-w-[1420px] items-center justify-between gap-4 px-[clamp(16px,4vw,32px)] py-4">
          <div className="flex items-center gap-3">
            <Diamond size={13} />
            <span className="font-serif text-[21px] font-semibold tracking-[-0.01em]">{name}</span>
          </div>
          <div className="flex items-center gap-6 text-[14px]" style={{ color: "#857a6c" }}>
            <span className="cursor-pointer hover:text-accent">{tr.t("manageBooking")}</span>
            {phone && <span className="hidden sm:inline">{phone}</span>}
          </div>
        </div>
      </header>

      {/* sub-bar */}
      <div className="sticky top-[65px] z-40 border-b" style={{ background: "#fffdfa", borderColor: "#ece4d8" }}>
        <div className="mx-auto flex max-w-[1420px] flex-wrap items-center justify-between gap-x-4 gap-y-3 px-[clamp(16px,4vw,32px)] py-3.5">
          <div className="flex flex-wrap items-center gap-3.5">
            <div
              className="flex items-center gap-2.5 rounded-[12px] px-4 py-2.5 text-[14px] font-semibold"
              style={{ background: "#f7f2ec", border: "1px solid #e8dfd0" }}
            >
              <Diamond />
              {datesLabel}
            </div>
            <button
              type="button"
              onClick={() => setEditingDates((v) => !v)}
              className="cursor-pointer text-[14px] font-semibold hover:text-accent"
              style={{ color: "#857a6c" }}
            >
              {hasDates ? tr.t("editDates") : tr.t("chooseDates")}
            </button>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-[14px] font-medium" style={{ color: "#857a6c" }}>
              {tr.p("staysAvailable", availableCount)}
            </div>
            <label
              className="flex items-center rounded-full py-2 pl-4 pr-2 text-[14px] font-semibold"
              style={{ background: "#f7f2ec", border: "1px solid #e3d9c9" }}
            >
              <span className="text-muted-2">{tr.t("sortLabel")} ·</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as typeof sort)}
                aria-label={tr.t("sortLabel")}
                className="cursor-pointer bg-transparent pl-1.5 pr-1 font-semibold text-ink outline-none"
              >
                <option value="asc">{tr.t("sortPriceAsc")}</option>
                <option value="desc">{tr.t("sortPriceDesc")}</option>
              </select>
            </label>
          </div>
        </div>

        {editingDates && (
          <div className="border-t" style={{ borderColor: "#ece4d8", background: "#fffdfa" }}>
            <div className="mx-auto flex max-w-[1420px] flex-wrap items-end gap-4 px-[clamp(16px,4vw,32px)] py-4">
              <div className="relative flex gap-2">
                <button
                  type="button"
                  onClick={() => dates.setOpen?.(true)}
                  className="rounded-[10px] border px-4 py-2.5 text-left text-[14px] font-semibold"
                  style={{ borderColor: "#e8dfd0", background: "#f7f2ec" }}
                >
                  <span className="block text-[11px] uppercase tracking-wide text-muted-2">
                    {tr.t("datesLabel")}
                  </span>
                  {dates.checkinLabel || tr.t("checkIn")} — {dates.checkoutLabel || tr.t("checkOut")}
                </button>
                {dates.open && <CalendarPopover state={dates} onClose={() => dates.setOpen?.(false)} />}
              </div>
              <GuestSelector value={occupancy} onChange={setOccupancy} />
              <button
                type="button"
                onClick={applyDates}
                disabled={!dates.checkinIso || !dates.checkoutIso}
                className="rounded-[10px] bg-accent px-6 py-2.5 text-[14px] font-semibold text-white hover:bg-accent-deep disabled:opacity-50"
              >
                {tr.t("searchLabel")}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* intro */}
      <div className="mx-auto max-w-[1420px] px-[clamp(16px,4vw,32px)] pb-2 pt-[34px]">
        <div className="mb-3 text-[13px] font-semibold uppercase tracking-[0.16em] text-accent">
          {destination ? `${destination} · ` : ""}
          {properties.length} {properties.length === 1 ? "property" : "properties"}
        </div>
        <h1 className="mb-2 font-serif text-[clamp(30px,6vw,42px)] font-medium leading-[1.05] tracking-[-0.02em]">
          {heading || tr.t("collectionHeading")}
        </h1>
        {intro && (
          <p className="m-0 max-w-[620px] text-[16px] leading-[1.6]" style={{ color: "#6f6557" }}>
            {intro}
          </p>
        )}
      </div>

      {/* split */}
      <main className="mx-auto flex max-w-[1420px] flex-col items-stretch gap-7 px-[clamp(16px,4vw,32px)] pb-16 pt-[22px] lg:flex-row lg:items-start">
        {/* list */}
        <div className="flex min-w-0 flex-col gap-4 lg:flex-[1.25] lg:basis-[380px]">
          {properties.length === 0 && (
            <p className="text-[15px]" style={{ color: "#6f6557" }}>
              {tr.t("noPropertiesYet")}
            </p>
          )}
          {listProps.map((p) => {
            const id = p.urlSeg;
            const on = hoveredId === id || activeId === id;
            return (
              <div
                key={id}
                id={`prop-${id}`}
                onMouseEnter={() => setHoveredId(id)}
                onMouseLeave={() => setHoveredId(null)}
                className="flex flex-wrap overflow-hidden rounded-[16px] bg-white transition-all"
                style={{
                  border: `1.5px solid ${on ? "var(--accent)" : "#efe7da"}`,
                  boxShadow: on ? "0 20px 40px -26px rgba(70,55,35,0.45)" : "0 1px 0 rgba(70,55,35,0.02)",
                }}
              >
                <div
                  className="relative min-h-[200px] flex-[1_1_220px] self-stretch"
                  style={{ background: p.photo ? undefined : HATCH }}
                >
                  {p.photo && <img src={p.photo} alt={p.name} className="h-full w-full object-cover" />}
                  <span
                    className="absolute left-3 top-3 rounded-full px-2.5 py-[5px] text-[11px] font-bold uppercase tracking-[0.04em]"
                    style={{ background: "rgba(255,253,250,0.92)", color: "#5a5145" }}
                  >
                    {p.typeLabel}
                  </span>
                </div>
                <div className="flex flex-[2_1_300px] flex-col p-[22px_24px]">
                  {p.area && (
                    <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.1em]" style={{ color: "#9a8f80" }}>
                      {p.area}
                    </div>
                  )}
                  <h3 className="mb-3 font-serif text-[23px] font-semibold tracking-[-0.01em]">{p.name}</h3>
                  {p.chips.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {p.chips.map((c) => (
                        <span
                          key={c}
                          className="rounded-full px-3 py-[5px] text-[12.5px] font-medium"
                          style={{ color: "#6f6557", background: "#f5efe5", border: "1px solid #ece3d4" }}
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mt-auto flex items-end justify-between gap-4 pt-[18px]">
                    <div className="flex items-baseline gap-[7px]">
                      {p.soldOut ? (
                        <span className="text-[15px] font-semibold" style={{ color: "#9a8f80" }}>
                          {hasDates ? tr.t("soldOutDates") : ""}
                        </span>
                      ) : p.fromPrice ? (
                        <>
                          <span className="text-[13px]" style={{ color: "#9a8f80" }}>{tr.t("from")}</span>
                          <span className="font-serif text-[28px] font-semibold leading-none">{p.fromPrice}</span>
                          <span className="text-[13px]" style={{ color: "#9a8f80" }}>{tr.t("perNightShort")}</span>
                        </>
                      ) : (
                        <span className="text-[14px]" style={{ color: "#9a8f80" }}>{tr.t("selectDatesForPrices")}</span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => goToProperty(p)}
                      disabled={p.soldOut}
                      className="flex-none rounded-[10px] bg-accent px-[22px] py-[11px] text-[14.5px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {tr.t("viewProperty")}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* map */}
        <div className="order-first min-w-0 self-stretch lg:order-none lg:flex-1 lg:basis-[360px]">
          <div
            className="relative h-[340px] overflow-hidden rounded-[18px] lg:sticky lg:top-[132px] lg:h-[calc(100vh-160px)]"
            style={{ border: "1px solid #e3d9c9", boxShadow: "0 22px 50px -30px rgba(70,55,35,0.35)", minHeight: 320 }}
          >
            {mapKey ? (
              <GoogleCollectionMap
                mapKey={mapKey}
                properties={properties}
                hoveredId={hoveredId}
                activeId={activeId}
                setHoveredId={setHoveredId}
                onPinClick={clickPin}
                fallback={
                  <StylizedMap
                    properties={properties}
                    hoveredId={hoveredId}
                    activeId={activeId}
                    setHoveredId={setHoveredId}
                    clickPin={clickPin}
                  />
                }
              />
            ) : (
              <StylizedMap
                properties={properties}
                hoveredId={hoveredId}
                activeId={activeId}
                setHoveredId={setHoveredId}
                clickPin={clickPin}
              />
            )}

            {/* chrome — sits above whichever map is shown */}
            <div
              className="pointer-events-none absolute left-4 top-4 z-[6] flex items-center gap-2 rounded-full px-[15px] py-2 text-[13px] font-semibold"
              style={{ background: "rgba(255,253,250,0.94)", border: "1px solid #e8dfd0", color: "#5a5145", boxShadow: "0 6px 18px -10px rgba(70,55,35,0.4)" }}
            >
              <Diamond />
              {tr.p("staysInView", availableCount)}
            </div>
          </div>
        </div>
      </main>

      {/* footer */}
      <footer className="border-t" style={{ borderColor: "#ece4d8", background: "#fffdfa" }}>
        <div className="mx-auto flex max-w-[1420px] flex-wrap items-center justify-between gap-4 px-[clamp(16px,4vw,32px)] py-[22px] text-[13px]" style={{ color: "#9a8f80" }}>
          <span>© 2026 {name} · {tr.t("allRightsReserved")}</span>
          <span>{tr.t("footerRight")}</span>
        </div>
      </footer>
    </div>
  );
}

type MapProps = {
  properties: PropView[];
  hoveredId: string | null;
  activeId: string | null;
  setHoveredId: (id: string | null) => void;
};

// ---- Stylized fallback map (no API key / Maps failed to load) ------------
// The original hand-drawn canvas: pins positioned by normalized lat/lng.
function StylizedMap({
  properties,
  hoveredId,
  activeId,
  setHoveredId,
  clickPin,
}: MapProps & { clickPin: (id: string) => void }) {
  return (
    <>
      <div
        className="absolute inset-0"
        style={{
          background:
            "repeating-linear-gradient(0deg,transparent,transparent 46px,rgba(120,110,90,0.055) 46px,rgba(120,110,90,0.055) 48px),repeating-linear-gradient(90deg,transparent,transparent 54px,rgba(120,110,90,0.055) 54px,rgba(120,110,90,0.055) 56px),#e7e3d7",
        }}
      >
        <div style={{ position: "absolute", left: "6%", top: "9%", width: "24%", height: "22%", borderRadius: 16, background: "oklch(0.86 0.045 145)" }} />
        <div style={{ position: "absolute", left: "70%", top: "60%", width: "26%", height: "30%", borderRadius: 16, background: "oklch(0.86 0.045 145)" }} />
        <div style={{ position: "absolute", left: "-18%", top: "52%", width: "150%", height: 58, transform: "rotate(-20deg)", background: "oklch(0.82 0.035 232)", boxShadow: "0 0 0 1px oklch(0.76 0.04 232) inset" }} />
        <div style={{ position: "absolute", left: "-10%", top: "34%", width: "130%", height: 13, transform: "rotate(8deg)", background: "#f1ede2" }} />
        <div style={{ position: "absolute", left: "40%", top: "-10%", width: 13, height: "130%", transform: "rotate(6deg)", background: "#f1ede2" }} />
      </div>

      {properties.map((p) => {
        if (p.left == null || p.top == null) return null;
        const id = p.urlSeg;
        const on = hoveredId === id || activeId === id;
        return (
          <div
            key={id}
            onClick={() => clickPin(id)}
            onMouseEnter={() => setHoveredId(id)}
            onMouseLeave={() => setHoveredId(null)}
            className="absolute cursor-pointer whitespace-nowrap rounded-full border-[1.5px] px-3 py-[7px] text-[13px] font-bold transition-all"
            style={{
              left: `${p.left}%`,
              top: `${p.top}%`,
              transform: `translate(-50%,-50%) scale(${on ? 1.12 : 1})`,
              zIndex: activeId === id ? 14 : hoveredId === id ? 12 : 3,
              background: on ? "var(--accent)" : "#fffdfa",
              color: on ? "#fff" : "#2a2521",
              borderColor: on ? "var(--accent)" : "#e3d9c9",
              boxShadow: on ? "0 12px 26px -10px rgba(70,55,35,0.6)" : "0 4px 12px -6px rgba(70,55,35,0.4)",
            }}
          >
            {p.fromPrice ?? p.name}
          </div>
        );
      })}
    </>
  );
}

// ---- Real Google map -----------------------------------------------------
// Loads the Maps JS API once (browser only), drops a styled price-pill marker
// per geocoded property, and keeps hover/active state in sync with the list.
// Uses classic google.maps.Marker (works with only a JS API key — no Map ID
// needed, unlike AdvancedMarkerElement). Falls back to the stylized map if the
// script can't load (offline / bad key / blocked).
// Google's official inline bootstrap loader. It defines `google.maps.importLibrary`
// SYNCHRONOUSLY (queuing calls until the API is fetched), which is the only
// reliable way to know when the constructors are ready. A hand-rolled
// `<script>` + `onload` does NOT work with the modern loader: at onload time
// neither the Map/Marker constructors nor even `importLibrary` are attached yet,
// so `new google.maps.Map()` throws "not a constructor" — which previously made
// the map silently fall back to the stylized canvas.
function bootstrapGoogleMaps(params: Record<string, string>) {
  ((g: any) => {
    let h: any, a: any, k: any;
    const p = "The Google Maps JavaScript API",
      c = "google",
      l = "importLibrary",
      q = "__ib__",
      m = document,
      b: any = (window as any)[c] || ((window as any)[c] = {});
    const d = b.maps || (b.maps = {}),
      r = new Set<string>(),
      e = new URLSearchParams(),
      u = () =>
        h ||
        (h = new Promise<void>((f, n) => {
          a = m.createElement("script");
          e.set("libraries", [...r] + "");
          for (k in g) e.set(k.replace(/[A-Z]/g, (t: string) => "_" + t[0].toLowerCase()), g[k]);
          e.set("callback", c + ".maps." + q);
          a.src = `https://maps.${c}apis.com/maps/api/js?` + e;
          d[q] = f;
          a.onerror = () => (h = n(new Error(p + " could not load.")));
          a.nonce = (m.querySelector("script[nonce]") as HTMLScriptElement | null)?.nonce || "";
          m.head.append(a);
        }));
    d[l]
      ? console.warn(p + " only loads once. Ignoring:", g)
      : (d[l] = (f: string, ...n: any[]) => r.add(f) && u().then(() => d[l](f, ...n)));
  })(params);
}

let mapsReadyPromise: Promise<void> | null = null;
function loadGoogleMaps(key: string): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (mapsReadyPromise) return mapsReadyPromise;
  const g = () => (window as any).google;
  if (!g()?.maps?.importLibrary) {
    bootstrapGoogleMaps({ key, v: "weekly" });
  }
  // importLibrary resolves only once the constructors are actually available.
  mapsReadyPromise = Promise.all([
    g().maps.importLibrary("maps"),
    g().maps.importLibrary("marker"),
  ])
    .then(() => undefined)
    .catch((e) => {
      mapsReadyPromise = null; // allow a retry on remount
      throw e;
    });
  return mapsReadyPromise;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "'" ? "&apos;" : "&quot;",
  );
}

// A rounded price-pill as an SVG data-URI, matching the list/pin styling.
function pinIcon(g: any, label: string, active: boolean, accent: string) {
  const w = Math.max(46, Math.round(label.length * 8.4) + 24);
  const h = 30;
  const bg = active ? accent : "#fffdfa";
  const fg = active ? "#ffffff" : "#2a2521";
  const stroke = active ? accent : "#d8ccb8";
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>` +
    `<rect x='1' y='1' rx='15' ry='15' width='${w - 2}' height='${h - 2}' fill='${bg}' stroke='${stroke}' stroke-width='1.5'/>` +
    `<text x='${w / 2}' y='${h / 2 + 1}' text-anchor='middle' dominant-baseline='middle' font-family='Arial,Helvetica,sans-serif' font-size='13' font-weight='700' fill='${fg}'>${escapeXml(label)}</text>` +
    `</svg>`;
  return {
    url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
    scaledSize: new g.maps.Size(w, h),
    anchor: new g.maps.Point(w / 2, h / 2),
  };
}

function GoogleCollectionMap({
  mapKey,
  properties,
  hoveredId,
  activeId,
  setHoveredId,
  onPinClick,
  fallback,
}: MapProps & { mapKey: string; onPinClick: (id: string) => void; fallback: React.ReactNode }) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<Map<string, any>>(new Map());
  const accentRef = useRef<string>("#b45309");
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  const geo = properties.filter((p) => p.lat != null && p.lng != null);
  // Signature so markers rebuild when coordinates or prices change (date search).
  const sig = geo.map((p) => `${p.urlSeg}:${p.lat}:${p.lng}:${p.fromPrice ?? ""}`).join("|");

  // Init the map once the script is available.
  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps(mapKey)
      .then(() => {
        if (cancelled || !elRef.current) return;
        const g = (window as any).google;
        accentRef.current =
          getComputedStyle(elRef.current).getPropertyValue("--accent").trim() || "#b45309";
        mapRef.current = new g.maps.Map(elRef.current, {
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          clickableIcons: false,
          zoomControl: true,
          gestureHandling: "greedy",
          center: { lat: 20, lng: 0 },
          zoom: 2,
        });
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapKey]);

  // (Re)build markers when the map is ready or the property data changes.
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const g = (window as any).google;
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current.clear();
    const bounds = new g.maps.LatLngBounds();
    geo.forEach((p) => {
      const pos = { lat: p.lat as number, lng: p.lng as number };
      const m = new g.maps.Marker({
        position: pos,
        map: mapRef.current,
        title: p.name,
        icon: pinIcon(g, p.fromPrice ?? p.name, false, accentRef.current),
      });
      m.addListener("click", () => onPinClick(p.urlSeg));
      m.addListener("mouseover", () => setHoveredId(p.urlSeg));
      m.addListener("mouseout", () => setHoveredId(null));
      markersRef.current.set(p.urlSeg, m);
      bounds.extend(pos);
    });
    if (geo.length === 1) {
      mapRef.current.setCenter(bounds.getCenter());
      mapRef.current.setZoom(14);
    } else if (geo.length > 1) {
      mapRef.current.fitBounds(bounds, 64);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, sig]);

  // Reflect hover/active by swapping the pill icon + raising the z-index.
  useEffect(() => {
    if (!ready) return;
    const g = (window as any).google;
    markersRef.current.forEach((m, id) => {
      const p = geo.find((x) => x.urlSeg === id);
      if (!p) return;
      const on = hoveredId === id || activeId === id;
      m.setIcon(pinIcon(g, p.fromPrice ?? p.name, on, accentRef.current));
      m.setZIndex(activeId === id ? 1000 : on ? 500 : 1);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredId, activeId, ready]);

  if (failed) return <>{fallback}</>;
  return <div ref={elRef} className="absolute inset-0" style={{ background: "#e7e3d7" }} />;
}

// Thin wrapper around useDateRange that also tracks the popover open state, so
// the collection sub-bar can open/close the calendar itself.
function useDateRangeSafe(checkin: string, checkout: string, tr: ReturnType<typeof makeTranslator>) {
  const [open, setOpen] = useState(false);
  // Lazy import avoided — useDateRange is a hook, must be called unconditionally.
  const state = useDateRange({
    closedDates: null,
    initialCheckin: checkin || undefined,
    initialCheckout: checkout || undefined,
    tr,
  });
  return { ...state, open, setOpen };
}
