import { addMonths, format } from "date-fns";
import { useEffect, useState } from "react";
import { redirect, useNavigate, useNavigation, useSearchParams } from "react-router";

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

import { getCalendarAvailability } from "~/lib/catalog.server";
import { getRenderSections } from "~/lib/site.server";
import { loadSectionData } from "~/lib/section-data.server";
import { settingOf } from "~/lib/sections";
import { SectionList } from "~/components/section-list";
import { earliestCheckinDate } from "~/lib/dates";
import { useDateRange } from "~/lib/use-date-range";
import { useBase } from "~/lib/base";
import { resolveRequestPropertyOrNull } from "~/lib/property-scope.server";
import { loadPartnerPicker, loadPicker } from "~/lib/picker.server";
import { getPartner, partnerIdForAdminHost, partnerIdForGuestHost } from "~/lib/partners.server";
import { PropertyPicker } from "~/components/property-picker";
import { useSiteStyle } from "~/components/site-style";
import { cx } from "~/lib/site-style";

export async function loader({ params, request }: Route.LoaderArgs) {
  const lang = langFromRequest(request);
  // :channelId may be a slug — resolve to the real id for data lookups.
  //
  // This route is BOTH "/spilmanhotel" and "/". At the root with a hostname that
  // isn't a custom domain there is no property, and that is not an error — it is
  // the shared domain's front door, which lists everything bookable instead.
  // Route matching cannot see the hostname, so the branch has to be here.
  const pid = await resolveRequestPropertyOrNull(params.channelId, request);
  if (!pid) {
    const hostname = new URL(request.url).hostname;
    // A partner's guest host fronts THEIR properties under THEIR brand; a
    // partner's admin host has no guest content at all — its root is a door,
    // so send the visitor to the sign-in it exists for.
    const guestPartnerId = await partnerIdForGuestHost(hostname);
    if (guestPartnerId) {
      const partner = await getPartner(guestPartnerId);
      if (partner) return { mode: "picker" as const, picker: await loadPartnerPicker(partner) };
    }
    if (await partnerIdForAdminHost(hostname)) throw redirect("/admin/login");
    return { mode: "picker" as const, picker: await loadPicker() };
  }
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
    mode: "property" as const,
    closedDates,
    content,
    earliestCheckin: earliestCheckinDate(cutoff, now),
    sections,
    data,
  };
}

export function meta({ matches, loaderData }: Route.MetaArgs) {
  // The picker is ours (or a partner's), not a hotel's — it must not inherit a
  // property's title.
  if (loaderData?.mode === "picker") {
    return [
      { title: `Book direct — ${loaderData.picker.brandName ?? "Roompanda"}` },
      {
        name: "description",
        content: "Browse and book hotels and apartments directly, commission-free.",
      },
    ];
  }
  return pageMeta(matches, { titleKey: "metaHome", descKey: "metaDescHome" });
}

export default function Search({ loaderData, params }: Route.ComponentProps) {
  // Shared domain root: no property to search, so show what there is to book.
  if (loaderData.mode === "picker") return <PropertyPicker {...loaderData.picker} />;

  const base = useBase();
  const { closedDates, content, earliestCheckin, sections, data } = loaderData;
  const { property, currency, hotelName } = useProperty();
  const tr = useT();
  const style = useSiteStyle();
  const s = style.slots;
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

  // Default is the property name, NOT anything parsed out of the address —
  // address formats vary too much for a split to be safe (a Portuguese
  // "Rua da Torre, n12" put the house number in the hero).
  const eyebrow = content.eyebrow || hotelName;
  const heading = content.heading || DEFAULT_SEARCH.heading;
  const intro = content.intro || DEFAULT_SEARCH.intro;
  // Only offer the toggle when there's actually something clamped. Six lines at
  // this size is roughly 300 characters, so anything shorter is left alone and a
  // normal one-line lede never grows a "read more" it doesn't need.
  const introLong = intro.length > 300;
  const [introOpen, setIntroOpen] = useState(false);
  const promoText = content.promoText || DEFAULT_SEARCH.promoText;
  const promoPlaceholder = content.promoPlaceholder || DEFAULT_PROMO_PLACEHOLDER;
  const searchButton = content.searchButton || DEFAULT_SEARCH.searchButton;
  const highlights = content.highlights?.length ? content.highlights : DEFAULT_SEARCH.highlights;
  const heroPhoto = content.heroImage || property.photos?.[0]?.url;
  // The hero photo, else the first gallery photo — on a website with a gallery
  // the hero image was otherwise never shown at all.
  const heroSection = sections.find((s) => s.type === "hero");
  const heroImage = heroPhoto || data.gallery[0]?.url;
  // The style's arrangement wins over the hotel's split/wide setting — the layout
  // of the page is what a template is for. With no photo at all there's nothing
  // to lay copy over, so it falls back to the same wide column as `split` does.
  const overlayPhoto = heroSection && style.hero === "overlay" ? heroImage : undefined;
  const heroSplit =
    !overlayPhoto && heroSection && settingOf(heroSection, "layout", "split") === "split"
      ? heroImage
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
    navigate(`${base}/rooms?${qs.toString()}`);
  }

  // The hero stays inline: it owns the search form's state (dates, guests,
  // promo, calendar), and lifting it out would mean threading all of that
  // through the section renderer for nothing.
  const heroCopy = (mode: "split" | "wide" | "overlay") => (
    <div
      className={cx(
        mode === "wide" && "max-w-[680px]",
        mode === "overlay" && "max-w-[760px] text-center",
      )}
    >
      {/* Overlay spells the eyebrow out in utilities instead of reusing the
          `.eyebrow` class: that rule is unlayered CSS setting `color: accent`, so
          it would beat a `text-white` utility and leave the eyebrow unreadable on
          a dark photo. Same 13px/0.16em, different colour. */}
      <div
        className={cx(
          mode === "overlay"
            ? "text-caption font-semibold uppercase tracking-[0.16em] text-white/85"
            : "eyebrow",
          "mb-[18px]",
        )}
      >
        {eyebrow}
      </div>
      <h1
        className={cx(
          "mb-[18px]",
          s.heroDisplay,
          mode === "split" ? "text-display-lg lg:text-display-xl" : "text-display-xl",
          mode === "overlay" && "text-white",
        )}
      >
        {heading}
      </h1>
      {/* The intro is meant to be a lede, but nothing stops a hotel pasting its
          whole "about us" in — Spilman has four paragraphs here, which on a phone
          pushed the date picker to y≈1970, more than two screens down a booking
          page. Clamped to six lines below `sm` with the rest one tap away; the
          full text is always in the DOM, so nothing is hidden from search engines
          and desktop is untouched. */}
      <div className={cx(mode === "wide" && "mb-9", mode !== "wide" && "mb-0")}>
        <p
          className={cx(
            "whitespace-pre-line text-title-sm leading-[1.6]",
            mode === "overlay" ? "text-white/90" : "text-secondary",
            mode === "wide" && "max-w-[560px]",
            mode === "overlay" && "mx-auto max-w-[560px]",
            !introOpen && "line-clamp-6 sm:line-clamp-none",
          )}
        >
          {intro}
        </p>
        {introLong && (
          <button
            type="button"
            onClick={() => setIntroOpen((v) => !v)}
            aria-expanded={introOpen}
            className={cx(
              "mt-2 text-caption font-semibold underline-offset-2 hover:underline sm:hidden",
              mode === "overlay" ? "text-white" : "text-accent",
            )}
          >
            {introOpen ? tr.t("readLess") : tr.t("readMore")}
          </button>
        )}
      </div>
    </div>
  );

  // The search card and the promo toggle. Wrapped only when the style asks for
  // it (a bleeding hero has no container of its own to sit in) — an empty
  // `heroInner` emits no element, so the classic markup is untouched.
  const heroBooking = (fields: React.ReactNode) =>
    s.heroInner ? <div className={s.heroInner}>{fields}</div> : fields;

  const hero = (
    <div key="hero">
      {/* Split puts the property photo beside the copy instead of leaving the
          right half of the page empty. It needs an actual image to show, so it
          falls back to the single full-width column when there isn't one —
          better a narrow column than an empty half. The search card spans the
          full width below either way, so it stays the most prominent thing. */}
      {overlayPhoto ? (
        <div className="relative mb-9 overflow-hidden">
          <img
            {...imageProps(overlayPhoto, IMAGE_SIZES.full)}
            alt={hotelName}
            className="absolute inset-0 h-full w-full object-cover"
          />
          {/* A scrim, not a tint: the copy is white over a photo nobody has
              vetted, and a bright sky would otherwise leave the heading
              unreadable. */}
          <div className="absolute inset-0 bg-black/40" />
          {/* The copy block carries its own floor as well as the band's: a
              two-word hotel name at display size, centred in 420px of
              photograph, otherwise reads as a mistake. */}
          <div className="relative flex min-h-[420px] items-center justify-center px-7 py-16">
            <div className="flex min-h-[180px] flex-col justify-center">
              {heroCopy("overlay")}
            </div>
          </div>
        </div>
      ) : heroSplit ? (
        <div className="mb-9 grid grid-cols-1 gap-10 lg:grid-cols-[1.1fr_1fr]">
          {heroCopy("split")}
          {/* The COPY sets the row height, not the photo: grid stretch matches
              the photo to the text, with a floor so a one-line intro doesn't
              leave a sliver and a ceiling so a long one doesn't produce a
              1,000px portrait. */}
          <div
            className={cx(
              "min-h-[320px] overflow-hidden",
              s.mediaLarge,
              "bg-surface-alt lg:h-full lg:max-h-[560px]",
            )}
          >
            <img
              {...imageProps(heroSplit, IMAGE_SIZES.heroSplit)}
              alt={hotelName}
              className="h-full w-full object-cover"
            />
          </div>
        </div>
      ) : (
        heroCopy("wide")
      )}

      {heroBooking(
        <>
      {/* search card — `#book` is the anchor the room cards jump to */}
      <div className={cx("relative max-w-[920px]", s.headingAlign && "mx-auto")} id="book">
        <div
          className={cx("flex flex-wrap items-stretch gap-1.5", s.strip, "p-3.5")}
          style={{ boxShadow: "var(--shadow-card)" }}
        >
          <button
            type="button"
            onClick={() => setShowCal(true)}
            className="min-w-[150px] flex-1 cursor-pointer rounded-card px-[18px] py-3.5 text-left transition-colors hover:bg-field-hover"
          >
            <div className="field-label mb-1.5">{tr.t("checkIn")}</div>
            <div
              className="text-lead font-semibold"
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
              className="text-lead font-semibold"
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
            className="min-h-16 flex-none cursor-pointer rounded-card bg-accent px-[34px] text-lead font-semibold text-on-accent transition-colors hover:bg-accent-deep disabled:opacity-70"
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
          <span className="text-title-sm leading-none text-accent">{showPromo ? "\u2212" : "+"}</span>
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
        </>,
      )}
    </div>
  );

  return (
    <main className={s.page}>
      <SectionList
        sections={sections}
        data={data}
        tr={tr}
        hotelName={hotelName}
        hero={hero}
        highlights={highlights}
      />
    </main>
  );
}
