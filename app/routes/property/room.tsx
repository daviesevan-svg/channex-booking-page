// Website room page — the "tell me about this room" page, with an always-on
// availability calendar for that room alone.
//
// Deliberately a different route from `rooms/:roomId`, which is the funnel's
// dated rate-selection step and redirects home without dates. This one works
// with no dates at all: browse the room, see when it's free, then pick a range
// and hand off to that page with the dates in the query.

import { addMonths, format } from "date-fns";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import type { Route } from "./+types/room";
import { pageMeta } from "~/lib/page-meta";
import { imageProps, IMAGE_SIZES } from "~/lib/image-srcset";
import { CalendarLegend, CalendarMonths, CalendarNav } from "~/components/calendar-body";
import { GuestSelector } from "~/components/guest-selector";
import { Diamond } from "~/components/sections";
import { useT } from "~/lib/i18n";
import { VR_AMENITY_KEYS } from "~/lib/content";
import { getCalendarAvailability, getRoom, getRatesForRoom } from "~/lib/catalog.server";
import { getBookingCutoff, getSettings } from "~/lib/overrides.server";
import { resolvePropertyId } from "~/lib/properties.server";
import { earliestCheckinDate } from "~/lib/dates";
import type { Occupancy } from "~/lib/occupancy";
import { readOccupancy, writeOccupancy } from "~/lib/occupancy";
import { useDateRange } from "~/lib/use-date-range";
import { useBase } from "~/lib/base";

export async function loader({ params, request }: Route.LoaderArgs) {
  const pid = await resolvePropertyId(params.channelId);
  const settings = await getSettings(pid);
  // The room page belongs to the website layer. With it off there is no
  // website, so this URL shouldn't exist — 404 rather than serve an orphan.
  if (!settings.websiteEnabled) throw new Response("Not Found", { status: 404 });

  const room = await getRoom(pid, params.roomId);
  if (!room) throw new Response("Not Found", { status: 404 });

  const now = new Date();
  const [closedDates, cutoff, rates] = await Promise.all([
    // This room only — "when is THIS room free" is a different question from
    // the search calendar's "when is anything free".
    getCalendarAvailability(
      pid,
      format(now, "yyyy-MM-dd"),
      format(addMonths(now, 13), "yyyy-MM-dd"),
      { roomId: room.id },
    ).catch(() => null),
    getBookingCutoff(pid),
    getRatesForRoom(pid, room.id).catch(() => []),
  ]);

  return {
    room: {
      id: room.id,
      title: room.title,
      description: room.description,
      images: room.images,
      facilities: room.facilities,
      // Structured amenities use Google's vocabulary, translated under the
      // `am_*` keys the room detail page already uses — NOT the property-level
      // facility keys, which are a separate list on purpose.
      amenities: (room.amenities ?? []).filter((a) => VR_AMENITY_KEYS.has(a)),
      maxGuests: room.maxGuests,
    },
    rateNames: rates.filter((r) => r.active).map((r) => r.title),
    closedDates,
    earliestCheckin: earliestCheckinDate(cutoff, now),
    currency: settings.currency || "GBP",
  };
}

export function meta({ matches, loaderData }: Route.MetaArgs) {
  return pageMeta(matches, {
    titleKey: "metaDetail",
    descKey: "metaDescDetail",
    descText: loaderData?.room.description,
    vars: { room: loaderData?.room.title ?? "" },
  });
}

export default function RoomPage({ loaderData, params }: Route.ComponentProps) {
  const base = useBase();
  const { room, rateNames, closedDates, earliestCheckin, currency } = loaderData;
  const tr = useT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const dates = useDateRange({
    closedDates,
    minCheckin: earliestCheckin,
    initialCheckin: searchParams.get("checkin") ?? undefined,
    initialCheckout: searchParams.get("checkout") ?? undefined,
    tr,
  });
  const [occupancy, setOccupancy] = useState<Occupancy>(() => readOccupancy(searchParams));
  const [photo, setPhoto] = useState(0);

  const ready = Boolean(dates.checkinIso && dates.checkoutIso);

  function seeRates() {
    if (!ready) return;
    const qs = writeOccupancy(
      new URLSearchParams({
        checkin: dates.checkinIso!,
        checkout: dates.checkoutIso!,
        currency,
      }),
      occupancy,
    );
    const lang = searchParams.get("lang");
    if (lang) qs.set("lang", lang);
    navigate(`${base}/rooms/${room.id}?${qs.toString()}`);
  }

  const cover = room.images[photo] ?? room.images[0];

  return (
    <main className="mx-auto max-w-[1160px] px-7 pb-[72px] pt-10">
      <Link
        to={`${base}`}
        className="mb-6 inline-flex items-center gap-1.5 text-body font-semibold text-muted hover:text-accent"
      >
        ‹ {tr.t("backToHome")}
      </Link>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1.15fr_1fr]">
        {/* ---- photos + copy ---- */}
        <div>
          <div className="aspect-[3/2] overflow-hidden rounded-panel-lg bg-surface-alt">
            {cover ? (
              <img
                {...imageProps(cover, IMAGE_SIZES.full)}
                alt={room.title}
                className="h-full w-full object-cover"
              />
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
          {room.images.length > 1 && (
            <div className="mt-3 flex flex-wrap gap-2.5">
              {room.images.map((src, i) => (
                <button
                  key={src}
                  type="button"
                  onClick={() => setPhoto(i)}
                  aria-label={`${room.title} ${i + 1}`}
                  className={`h-[62px] w-[86px] flex-none overflow-hidden rounded-control border-2 ${i === photo ? "border-accent" : "border-transparent"}`}
                >
                  <img
                    {...imageProps(src, IMAGE_SIZES.galleryGrid)}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                </button>
              ))}
            </div>
          )}

          <h1 className="mb-2 mt-7 font-serif text-display-2xl font-medium leading-[1.1] tracking-[-0.01em]">
            {room.title}
          </h1>
          <div className="mb-5 text-body text-muted-2">
            {tr.t("sleeps", { n: room.maxGuests })}
          </div>
          {room.description && (
            <p className="mb-7 max-w-[560px] whitespace-pre-line text-lead leading-[1.7] text-secondary">
              {room.description}
            </p>
          )}

          {(room.facilities.length > 0 || room.amenities.length > 0) && (
            <div className="mb-7">
              <h2 className="mb-3 font-serif text-title-md font-semibold">{tr.t("inThisRoom")}</h2>
              <ul className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
                {room.amenities.map((key) => (
                  <li key={key} className="flex items-start gap-3 text-body-lg">
                    <Diamond className="mt-[7px]" size={7} />
                    {tr.t(`am_${key}`)}
                  </li>
                ))}
                {room.facilities.map((line, i) => (
                  <li key={`f${i}`} className="flex items-start gap-3 text-body-lg">
                    <Diamond className="mt-[7px]" size={7} />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {rateNames.length > 0 && (
            <div>
              <h2 className="mb-3 font-serif text-title-md font-semibold">{tr.t("ratesAvailable")}</h2>
              <div className="flex flex-wrap gap-2">
                {rateNames.map((name) => (
                  <span
                    key={name}
                    className="rounded-full border border-line-alt bg-surface-alt px-3.5 py-1.5 text-caption text-secondary"
                  >
                    {name}
                  </span>
                ))}
              </div>
              {/* Prices live on the next page, where there are dates to price
                  against. Naming the rates here without numbers is honest and
                  still tells the guest what they'll be choosing between. */}
              <p className="mt-2.5 text-label text-faint">{tr.t("ratesPricedOnDates")}</p>
            </div>
          )}
        </div>

        {/* ---- always-on availability ---- */}
        <div>
          <div
            className="rounded-panel-lg border border-line bg-surface p-[22px_22px_18px] lg:sticky lg:top-6"
            style={{ boxShadow: "var(--shadow-card)" }}
          >
            <CalendarNav state={dates} title={tr.t("roomAvailability")} />
            <CalendarMonths state={dates} />

            <div className="mt-4 border-t border-divider pt-3.5">
              <CalendarLegend />
              <div className="mt-4">
                <GuestSelector value={occupancy} onChange={setOccupancy} />
              </div>
              <button
                type="button"
                onClick={seeRates}
                disabled={!ready}
                className="mt-3 w-full cursor-pointer rounded-card bg-accent px-6 py-3.5 text-body-lg font-semibold text-white hover:bg-accent-deep disabled:cursor-default disabled:opacity-50"
              >
                {ready ? tr.t("seeRatesFor", { range: dates.rangeSummary }) : tr.t("pickYourDates")}
              </button>
              {!ready && (
                <p className="mt-2 text-center text-label text-faint">{tr.t("pickYourDatesHint")}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
