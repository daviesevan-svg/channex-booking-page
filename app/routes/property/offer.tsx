// One offer's page — what it is, and when you can actually have it.
//
// The room page's shape, for a deal: copy and terms on the left, an always-on
// availability calendar on the right, and a hand-off into the dated funnel once
// the guest has picked. It exists because the offers list used to send guests to
// the home page's search card, which reads as being bounced back to the homepage —
// nothing on screen said which offer you'd clicked or that it applied.
//
// The calendar shows REAL inventory availability, restricted to the dates this
// offer can cover: arrivals past its ceiling and departures past its stay window
// are greyed as out of range, and its minimum stay is enforced alongside the
// hotel's own. So every range the guest can select here is one the discount
// actually applies to — which is the honest version of "see the availability of
// the promo". The rules are still written out in full, because they, not this
// snapshot of today, are what checkout applies.

import { addMonths, format } from "date-fns";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import type { Route } from "./+types/offer";
import { CalendarLegend, CalendarMonths, CalendarNav } from "~/components/calendar-body";
import { GuestSelector } from "~/components/guest-selector";
import { Diamond } from "~/components/sections";
import { offerDate, offerHeadline, offerRules, OfferTerms } from "~/components/offers-section";
import { useBase } from "~/lib/base";
import { getCalendarAvailability } from "~/lib/catalog.server";
import { earliestCheckinDate, todayISODate } from "~/lib/dates";
import { useT } from "~/lib/i18n";
import type { Occupancy } from "~/lib/occupancy";
import { readOccupancy, writeOccupancy } from "~/lib/occupancy";
import { getBookingCutoff, getSettings } from "~/lib/overrides.server";
import { pageMeta } from "~/lib/page-meta";
import { getPublicOffers } from "~/lib/promotions.server";
import { resolveRequestProperty } from "~/lib/property-scope.server";
import { useDateRange } from "~/lib/use-date-range";
import { useSlots } from "~/components/site-style";
import { cx } from "~/lib/site-style";

export async function loader({ params, request }: Route.LoaderArgs) {
  const pid = await resolveRequestProperty(params.channelId, request);
  const settings = await getSettings(pid);
  // Part of the website layer, like the room page.
  if (!settings.websiteEnabled) throw new Response("Not Found", { status: 404 });

  // Straight from the same projection the list uses, so an offer that isn't
  // published — or whose dates have run out — has no page rather than a page
  // saying it can't be had.
  const offer = (await getPublicOffers(pid)).find((o) => o.id === params.offerId);
  if (!offer) throw new Response("Not Found", { status: 404 });

  const now = new Date();
  const [closedDates, cutoff] = await Promise.all([
    // Property-wide: an offer applies to every room, so "when is anything free"
    // is the right question here (the room page asks it per room).
    getCalendarAvailability(
      pid,
      format(now, "yyyy-MM-dd"),
      format(addMonths(now, 13), "yyyy-MM-dd"),
    ).catch(() => null),
    getBookingCutoff(pid),
  ]);

  // Two floors, and the later wins: the hotel's booking lead-time, and the first
  // date this offer's own rules allow.
  const cutoffFloor = earliestCheckinDate(cutoff, now);
  return {
    offer,
    closedDates,
    earliestCheckin:
      offer.earliestCheckin > cutoffFloor ? offer.earliestCheckin : cutoffFloor,
    currency: settings.currency || "GBP",
    today: todayISODate(),
  };
}

export function meta({ matches, loaderData }: Route.MetaArgs) {
  return pageMeta(matches, {
    titleKey: "metaOffer",
    descKey: "metaDescOffer",
    vars: { offer: loaderData?.offer.name ?? "" },
  });
}

export default function OfferPage({ loaderData }: Route.ComponentProps) {
  const { offer, closedDates, earliestCheckin, currency, today } = loaderData;
  const base = useBase();
  const tr = useT();
  const s = useSlots();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const minNights = offer.conditions?.minNights;
  const dates = useDateRange({
    closedDates,
    minCheckin: earliestCheckin,
    // The offer's own ceilings. Arrivals stop at `latestCheckin`; the stay itself
    // has to be over by `stayTo`, which is later whenever a minimum stay applies.
    maxCheckin: offer.latestCheckin,
    maxCheckout: offer.conditions?.stayTo,
    minNights,
    initialCheckin: searchParams.get("checkin") ?? undefined,
    initialCheckout: searchParams.get("checkout") ?? undefined,
    tr,
  });
  const [occupancy, setOccupancy] = useState<Occupancy>(() => readOccupancy(searchParams));

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
    // A code has to be carried; an automatic offer is applied by the rules the
    // guest has just satisfied, so there's nothing to pass.
    if (offer.code) qs.set("promo", offer.code);
    const lang = searchParams.get("lang");
    if (lang) qs.set("lang", lang);
    navigate(`${base}/rooms?${qs.toString()}`);
  }

  return (
    <main className="mx-auto max-w-[1160px] px-7 pb-[72px] pt-10">
      <Link
        to={`${base}/offers`}
        className="mb-6 inline-flex items-center gap-1.5 text-body font-semibold text-muted hover:text-accent"
      >
        ‹ {tr.t("offersBackToAll")}
      </Link>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1.15fr_1fr]">
        {/* ---- what the offer is ---- */}
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2.5">
            <span className="rounded-chip bg-accent-soft px-3 py-1.5 text-body font-semibold text-accent-deep">
              {offerHeadline(offer, tr, currency)}
            </span>
            <span className="text-body text-muted-2">
              {offer.trigger === "auto"
                ? tr.t("offerAutomatic")
                : tr.t("offerUseCode", { code: offer.code ?? "" })}
            </span>
          </div>

          <h1 className={cx("mb-5", s.h1)}>{offer.name}</h1>

          <h2 className={cx("mb-3", s.h3)}>{tr.t("offerTermsHeading")}</h2>
          <ul className="mb-7 flex flex-col gap-2">
            {offerRules(offer, tr).map((line) => (
              <li key={line} className="flex items-start gap-3 text-body-lg leading-[1.5]">
                <Diamond className="mt-[7px]" size={7} />
                {line}
              </li>
            ))}
            <li className="flex items-start gap-3 text-body-lg leading-[1.5]">
              <Diamond className="mt-[7px]" size={7} />
              {tr.t("offerAppliesAllRooms")}
            </li>
          </ul>

          {/* The same availability facts the card carries, so the two pages can't
              disagree about the dates. */}
          <OfferTerms offer={offer} tr={tr} today={today} />

          {offer.code && (
            <p className="mt-5 max-w-[520px] text-body leading-[1.55] text-muted">
              {tr.t("offerCodeAutoApplied", { code: offer.code })}
            </p>
          )}
        </div>

        {/* ---- when you can have it ---- */}
        <div>
          <div
            className={cx(s.panel, "p-[22px_22px_18px] lg:sticky lg:top-6")}
            style={{ boxShadow: "var(--shadow-card)" }}
          >
            {offer.status === "upcoming" ? (
              // Not bookable yet, so no calendar and no button: every range the
              // guest could pick today would miss the discount, and a search that
              // quietly drops it is worse than no search.
              <div>
                <h2 className={cx("mb-2", s.h3)}>{tr.t("offerAvailability")}</h2>
                <p className="text-body-lg font-semibold">
                  {tr.t("offerStatusUpcoming", {
                    date: offerDate(offer.bookFrom ?? offer.earliestCheckin, tr),
                  })}
                </p>
                <p className="mt-2 text-body leading-[1.55] text-muted">
                  {tr.t("offerUpcomingHint")}
                </p>
                <Link
                  to={base}
                  className={cx(
                    "mt-5 inline-block",
                    s.linkOutline,
                    "px-4 py-2 text-body font-semibold text-accent hover:bg-accent-soft",
                  )}
                >
                  {tr.t("offerSearchAnyway")}
                </Link>
              </div>
            ) : (
              <>
                <CalendarNav state={dates} title={tr.t("roomAvailability")} />
                <CalendarMonths state={dates} />

                <div className="mt-4 border-t border-divider pt-3.5">
                  <CalendarLegend />
                  {/* Said up front, not only when a too-short range is refused. */}
                  {minNights != null && minNights > 1 && (
                    <p className="mt-3 text-label text-muted">
                      {tr.p("offerNeedsNights", minNights)}
                    </p>
                  )}
                  <div className="mt-4">
                    <GuestSelector value={occupancy} onChange={setOccupancy} />
                  </div>
                  <button
                    type="button"
                    onClick={seeRates}
                    disabled={!ready}
                    className={cx(
                      "mt-3 w-full cursor-pointer px-6 py-3.5 text-body-lg font-semibold",
                      s.btnPrimary,
                      "disabled:cursor-default disabled:opacity-50",
                    )}
                  >
                    {ready
                      ? tr.t("seeRatesFor", { range: dates.rangeSummary })
                      : tr.t("pickYourDates")}
                  </button>
                  {!ready && (
                    <p className="mt-2 text-center text-label text-faint">
                      {tr.t("pickYourDatesHint")}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
