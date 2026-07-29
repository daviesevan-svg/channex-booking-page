import { addMonths, format } from "date-fns";
import { useEffect, useState } from "react";
import { useNavigate, useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/search";
import { pageMeta } from "~/lib/page-meta";
import { imageProps, IMAGE_SIZES } from "~/lib/image-srcset";
import { CalendarPopover } from "~/components/calendar-popover";
import { GuestSelector } from "~/components/guest-selector";
import { useProperty } from "~/lib/booking-context";
import { useT } from "~/lib/i18n";
import { DEFAULT_PROMO_PLACEHOLDER, DEFAULT_SEARCH, langFromRequest } from "~/lib/content";
import type { Occupancy } from "~/lib/occupancy";
import { readOccupancy, writeOccupancy } from "~/lib/occupancy";
import { getBookingCutoff, getSearchContent, getSettings } from "~/lib/overrides.server";
import { resolvePropertyId } from "~/lib/properties.server";
import { getCalendarAvailability } from "~/lib/catalog.server";
import { getRenderSections } from "~/lib/site.server";
import { loadSectionData } from "~/lib/section-data.server";
import { settingOf } from "~/lib/sections";
import { SectionList } from "~/components/section-list";
import { earliestCheckinDate } from "~/lib/dates";
import { useDateRange } from "~/lib/use-date-range";

export async function loader({ params, request }: Route.LoaderArgs) {
  const lang = langFromRequest(request);
  // :channelId may be a slug — resolve to the real id for data lookups.
  const pid = await resolvePropertyId(params.channelId);
  // Availability + min-stay for the calendar, from our inventory (D1). Cover the
  // calendar's horizon (it pages up to ~12 months out).
  const now = new Date();
  const [content, closedDates, cutoff, settings] = await Promise.all([
    getSearchContent(pid, lang),
    getCalendarAvailability(pid, format(now, "yyyy-MM-dd"), format(addMonths(now, 13), "yyyy-MM-dd")).catch(
      () => null, // fail open: a calendar data hiccup shouldn't break the page
    ),
    getBookingCutoff(pid),
    getSettings(pid),
  ]);
  // With the website layer off this returns the booking page's long-standing
  // section order, so that page is exactly what it always was.
  const sections = await getRenderSections(pid, lang, settings.websiteEnabled ?? false);
  // Everything the sections need, loaded only for the sections present. The hero
  // image is already in hand, so it's passed in rather than read twice.
  const data = await loadSectionData(
    pid,
    lang,
    sections,
    settings,
    content.heroImage || undefined,
  );
  // Earliest arrival the property currently accepts (lead-time cutoff), so the
  // calendar can grey out dates that are too last-minute to book.
  return {
    closedDates,
    content,
    earliestCheckin: earliestCheckinDate(cutoff, now),
    sections,
    data,
  };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageMeta(matches, { titleKey: "metaHome", descKey: "metaDescHome" });
}

export default function Search({ loaderData, params }: Route.ComponentProps) {
  const { closedDates, content, earliestCheckin, sections, data } = loaderData;
  const { property, currency, hotelName } = useProperty();
  const tr = useT();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const dates = useDateRange({
    closedDates,
    minCheckin: earliestCheckin,
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
    // Keep any #fragment: this runs on mount, and dropping it would wipe the
    // anchor the "Rooms" nav link just navigated to — so a reload or a copied
    // URL wouldn't come back to the section.
    const hash = window.location.hash;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}${hash}`,
    );
  }, [dates.checkinIso, dates.checkoutIso, occupancy]);
  const navigation = useNavigation();
  const searching = navigation.state === "loading";

  const eyebrow = content.eyebrow || (property.address?.split(",")[1] ?? hotelName).trim();
  const heading = content.heading || DEFAULT_SEARCH.heading;
  const intro = content.intro || DEFAULT_SEARCH.intro;
  const promoText = content.promoText || DEFAULT_SEARCH.promoText;
  const promoPlaceholder = content.promoPlaceholder || DEFAULT_PROMO_PLACEHOLDER;
  const searchButton = content.searchButton || DEFAULT_SEARCH.searchButton;
  const highlights = content.highlights?.length ? content.highlights : DEFAULT_SEARCH.highlights;
  const heroPhoto = content.heroImage || property.photos?.[0]?.url;
  // The hero photo, else the first gallery photo — on a website with a gallery
  // the hero image was otherwise never shown at all.
  const heroSection = sections.find((s) => s.type === "hero");
  const heroSplit =
    heroSection && settingOf(heroSection, "layout", "split") === "split"
      ? heroPhoto || data.gallery[0]?.url
      : undefined;

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

  // The hero stays inline: it owns the search form's state (dates, guests,
  // promo, calendar), and lifting it out would mean threading all of that
  // through the section renderer for nothing.
  const heroCopy = (split: boolean) => (
    <div className={split ? "" : "max-w-[680px]"}>
      <div className="eyebrow mb-[18px]">{eyebrow}</div>
      <h1
        className={`mb-[18px] font-serif font-medium leading-[1.05] tracking-[-0.02em] ${
          split ? "text-display-4xl lg:text-display-5xl" : "text-display-6xl"
        }`}
      >
        {heading}
      </h1>
      <p
        className={`whitespace-pre-line text-title-xs leading-[1.6] text-secondary ${
          split ? "mb-0" : "mb-9 max-w-[560px]"
        }`}
      >
        {intro}
      </p>
    </div>
  );

  const hero = (
    <div key="hero">
      {/* Split puts the property photo beside the copy instead of leaving the
          right half of the page empty. It needs an actual image to show, so it
          falls back to the single full-width column when there isn't one —
          better a narrow column than an empty half. The search card spans the
          full width below either way, so it stays the most prominent thing. */}
      {heroSplit ? (
        <div className="mb-9 grid grid-cols-1 gap-10 lg:grid-cols-[1.1fr_1fr]">
          {heroCopy(true)}
          {/* The COPY sets the row height, not the photo: grid stretch matches
              the photo to the text, with a floor so a one-line intro doesn't
              leave a sliver and a ceiling so a long one doesn't produce a
              1,000px portrait. */}
          <div className="min-h-[320px] overflow-hidden rounded-panel-lg bg-surface-alt lg:h-full lg:max-h-[560px]">
            <img
              {...imageProps(heroSplit, IMAGE_SIZES.heroSplit)}
              alt={hotelName}
              className="h-full w-full object-cover"
            />
          </div>
        </div>
      ) : (
        heroCopy(false)
      )}

      {/* search card — `#book` is the anchor the room cards jump to */}
      <div className="relative max-w-[920px]" id="book">
        <div
          className="flex flex-wrap items-stretch gap-1.5 rounded-panel-lg border border-line bg-surface p-3.5"
          style={{ boxShadow: "var(--shadow-card)" }}
        >
          <button
            type="button"
            onClick={() => setShowCal(true)}
            className="min-w-[150px] flex-1 cursor-pointer rounded-card px-[18px] py-3.5 text-left transition-colors hover:bg-field-hover"
          >
            <div className="field-label mb-1.5">{tr.t("checkIn")}</div>
            <div
              className="text-lead-lg font-semibold"
              style={{ color: dates.checkin ? "var(--color-ink)" : "var(--color-faint-2)" }}
            >
              {dates.checkinLabel}
            </div>
          </button>
          <div className="my-2 w-px bg-line" />
          <button
            type="button"
            onClick={() => setShowCal(true)}
            className="min-w-[150px] flex-1 cursor-pointer rounded-card px-[18px] py-3.5 text-left transition-colors hover:bg-field-hover"
          >
            <div className="field-label mb-1.5">{tr.t("checkOut")}</div>
            <div
              className="text-lead-lg font-semibold"
              style={{ color: dates.checkout ? "var(--color-ink)" : "var(--color-faint-2)" }}
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
            className="min-h-16 flex-none cursor-pointer rounded-card bg-accent px-[34px] text-lead font-semibold text-white transition-colors hover:bg-accent-deep disabled:opacity-70"
          >
            {searching ? tr.t("searching") : searchButton}
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
          <span className="text-title-xs leading-none text-accent">{showPromo ? "\u2212" : "+"}</span>
          {promoText}
        </button>
        {showPromo && (
          <input
            value={promoCode}
            onChange={(e) => setPromoCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") searchRooms();
            }}
            placeholder={promoPlaceholder}
            className="mt-2 block w-[240px] max-w-full rounded-control border border-line bg-surface px-3.5 py-2.5 text-body uppercase text-ink outline-none focus:border-accent"
          />
        )}
      </div>
    </div>
  );

  return (
    <main className="mx-auto max-w-[1160px] px-7 pb-[72px] pt-16">
      <SectionList
        sections={sections}
        data={data}
        tr={tr}
        channelId={params.channelId}
        hotelName={hotelName}
        hero={hero}
        highlights={highlights}
      />
    </main>
  );
}
