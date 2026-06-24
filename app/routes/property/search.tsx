import { useEffect, useState } from "react";
import { useNavigate, useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/search";
import { CalendarPopover } from "~/components/calendar-popover";
import { GuestSelector } from "~/components/guest-selector";
import { useProperty } from "~/lib/booking-context";
import { useT } from "~/lib/i18n";
import { getChannexClient } from "~/lib/config.server";
import { DEFAULT_SEARCH, langFromRequest } from "~/lib/content";
import type { Occupancy } from "~/lib/occupancy";
import { readOccupancy, writeOccupancy } from "~/lib/occupancy";
import { getSearchContent } from "~/lib/overrides.server";
import { useDateRange } from "~/lib/use-date-range";

export async function loader({ params, request }: Route.LoaderArgs) {
  const client = getChannexClient();
  const lang = langFromRequest(request);
  const [closedDates, content] = await Promise.all([
    client.getClosedDates(params.channelId).catch(() => null),
    getSearchContent(params.channelId, lang),
  ]);
  return { closedDates, content };
}

function Diamond({ size = 9, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      className={`inline-block flex-none rounded-[1px] bg-accent ${className}`}
      style={{ width: size, height: size, transform: "rotate(45deg)" }}
    />
  );
}

export default function Search({ loaderData, params }: Route.ComponentProps) {
  const { closedDates, content } = loaderData;
  const { property, currency, hotelName } = useProperty();
  const tr = useT();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const dates = useDateRange({
    closedDates,
    initialCheckin: searchParams.get("checkin") ?? undefined,
    initialCheckout: searchParams.get("checkout") ?? undefined,
    tr,
  });
  const [showCal, setShowCal] = useState(false);
  const [occupancy, setOccupancy] = useState<Occupancy>(() => readOccupancy(searchParams));
  const [promoCode, setPromoCode] = useState(() => searchParams.get("promo") ?? "");
  const [showPromo, setShowPromo] = useState(() => Boolean(searchParams.get("promo")));

  // Keep the landing-page URL in sync with the chosen dates/guests so it's a
  // shareable deep link (and matches the format 3rd parties can link in with).
  // Uses replaceState to avoid re-running the loader on every change.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (dates.checkinIso) sp.set("checkin", dates.checkinIso);
    else sp.delete("checkin");
    if (dates.checkoutIso) sp.set("checkout", dates.checkoutIso);
    else sp.delete("checkout");
    sp.set("adults", String(occupancy.adults));
    if (occupancy.childrenAge.length) sp.set("childrenAge", occupancy.childrenAge.join(","));
    else sp.delete("childrenAge");
    const qs = sp.toString();
    window.history.replaceState(
      window.history.state,
      "",
      qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
    );
  }, [dates.checkinIso, dates.checkoutIso, occupancy]);
  const navigation = useNavigation();
  const searching = navigation.state === "loading";

  const eyebrow = content.eyebrow || (property.address?.split(",")[1] ?? hotelName).trim();
  const heading = content.heading || DEFAULT_SEARCH.heading;
  const intro = content.intro || DEFAULT_SEARCH.intro;
  const promoText = content.promoText || DEFAULT_SEARCH.promoText;
  const searchButton = content.searchButton || DEFAULT_SEARCH.searchButton;
  const highlights = content.highlights?.length ? content.highlights : DEFAULT_SEARCH.highlights;
  const heroPhoto = content.heroImage || property.photos?.[0]?.url;

  function searchRooms() {
    if (!dates.checkinIso || !dates.checkoutIso) {
      setShowCal(true);
      return;
    }
    const qs = writeOccupancy(
      new URLSearchParams({
        checkin: dates.checkinIso,
        checkout: dates.checkoutIso,
        currency,
      }),
      occupancy,
    );
    const lang = searchParams.get("lang");
    if (lang) qs.set("lang", lang);
    const promo = promoCode.trim();
    if (promo) qs.set("promo", promo);
    navigate(`/${params.channelId}/rooms?${qs.toString()}`);
  }

  return (
    <main className="mx-auto max-w-[1160px] px-7 pb-[72px] pt-16">
      <div className="max-w-[680px]">
        <div className="eyebrow mb-[18px]">{eyebrow}</div>
        <h1 className="mb-[18px] font-serif text-[56px] font-medium leading-[1.05] tracking-[-0.02em]">
          {heading}
        </h1>
        <p className="mb-9 max-w-[560px] whitespace-pre-line text-[18px] leading-[1.6] text-secondary">
          {intro}
        </p>
      </div>

      {/* search card */}
      <div className="relative max-w-[920px]">
        <div
          className="flex flex-wrap items-stretch gap-1.5 rounded-[18px] border border-line bg-surface p-3.5"
          style={{ boxShadow: "var(--shadow-card)" }}
        >
          <button
            type="button"
            onClick={() => setShowCal(true)}
            className="min-w-[150px] flex-1 cursor-pointer rounded-[12px] px-[18px] py-3.5 text-left transition-colors hover:bg-field-hover"
          >
            <div className="field-label mb-1.5">{tr.t("checkIn")}</div>
            <div
              className="text-[17px] font-semibold"
              style={{ color: dates.checkin ? "#2a2521" : "#b6ab9d" }}
            >
              {dates.checkinLabel}
            </div>
          </button>
          <div className="my-2 w-px bg-line" />
          <button
            type="button"
            onClick={() => setShowCal(true)}
            className="min-w-[150px] flex-1 cursor-pointer rounded-[12px] px-[18px] py-3.5 text-left transition-colors hover:bg-field-hover"
          >
            <div className="field-label mb-1.5">{tr.t("checkOut")}</div>
            <div
              className="text-[17px] font-semibold"
              style={{ color: dates.checkout ? "#2a2521" : "#b6ab9d" }}
            >
              {dates.checkoutLabel}
            </div>
          </button>
          <div className="my-2 w-px bg-line" />
          <GuestSelector value={occupancy} onChange={setOccupancy} />
          <button
            type="button"
            onClick={searchRooms}
            disabled={searching}
            className="min-h-16 flex-none cursor-pointer rounded-[12px] bg-accent px-[34px] text-[16px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:opacity-70"
          >
            {searching ? "Searching…" : searchButton}
          </button>
        </div>

        {showCal && <CalendarPopover state={dates} onClose={() => setShowCal(false)} />}
      </div>

      <div className="mt-3.5">
        <button
          type="button"
          onClick={() => setShowPromo((v) => !v)}
          className="flex cursor-pointer items-center gap-1.5 text-sm text-muted hover:text-accent"
        >
          <span className="text-[18px] leading-none text-accent">{showPromo ? "−" : "+"}</span>
          {promoText}
        </button>
        {showPromo && (
          <input
            value={promoCode}
            onChange={(e) => setPromoCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") searchRooms();
            }}
            placeholder="SUMMER10"
            autoComplete="off"
            className="mt-2 block w-[240px] max-w-full rounded-[10px] border border-line bg-surface px-3.5 py-2.5 text-[14px] uppercase text-ink outline-none focus:border-accent"
          />
        )}
      </div>

      {/* highlights */}
      <div className="mt-12 grid max-w-[920px] grid-cols-1 gap-[18px] sm:grid-cols-3">
        {highlights.map((h, i) => (
          <div key={i} className="flex items-start gap-3.5">
            <Diamond className="mt-1.5" />
            <div>
              <div className="mb-0.5 text-[15px] font-semibold">{h.title}</div>
              <div className="text-sm leading-[1.5] text-muted">{h.description}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ambiance image */}
      <div className="relative mt-12 h-[300px] overflow-hidden rounded-[18px]">
        {heroPhoto ? (
          <img src={heroPhoto} alt={hotelName} className="h-full w-full object-cover" />
        ) : (
          <div
            className="h-full w-full"
            style={{
              background:
                "repeating-linear-gradient(135deg,#efe7da,#efe7da 13px,#e7ddcc 13px,#e7ddcc 26px)",
            }}
          />
        )}
      </div>
    </main>
  );
}
