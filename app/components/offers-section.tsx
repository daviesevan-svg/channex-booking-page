// Offers: the home-page section and the card the /offers page reuses.
//
// The two have to be one component. A guest who reads "10% off, book 60 days
// ahead" on the home page and then finds different words on the offers page has
// been told the terms twice, and only one of them can be the one checkout
// applies — so the sentences are written once, here, from the same conditions
// `offerMatches` evaluates when the discount is actually given.
//
// Nothing about an offer is authored in the section: promotions are edited on
// their own admin screen, and the section stores only a heading, an intro and how
// many to show. Same rule as the rooms section — one source of truth, so a
// discount can't go stale on the home page.

import { Link } from "react-router";

import { Diamond, SectionH2, sectionHeading } from "~/components/sections";
import { RichText } from "~/components/rich-text";
import { useBase } from "~/lib/base";
import { useProperty } from "~/lib/booking-context";
import { fmtDate } from "~/lib/dates";
import type { Translator } from "~/lib/i18n";
import { formatMoney } from "~/lib/money";
import type { OfferView } from "~/lib/promotions";
import { numberSetting, type SiteSection } from "~/lib/sections";
import { useSlots } from "~/components/site-style";
import { cx } from "~/lib/site-style";

/** Dates read as "4 Oct 2026" — the year is not optional here. Half of these are
 *  months out, and "4 Oct" on a December stay window is ambiguous by one year. */
function offerDate(iso: string, tr: Translator): string {
  return fmtDate(iso, "d MMM yyyy", tr.locale);
}

/** The saving, as the badge states it. */
export function offerHeadline(offer: OfferView, tr: Translator, currency: string): string {
  return offer.type === "percent"
    ? tr.t("offerPercentOff", { value: offer.value })
    : tr.t("offerAmountOff", { amount: formatMoney(offer.value, currency) });
}

/**
 * The offer's terms, one sentence per rule.
 *
 * Straight from the stored conditions rather than from the derived window: this
 * is what the hotel promised, and it stays true tomorrow. The dates worked out
 * against today go in the availability block below, where they're labelled as
 * such.
 */
export function offerRules(offer: OfferView, tr: Translator): string[] {
  const c = offer.conditions;
  if (!c) return [tr.t("offerAnyStay")];
  const out: string[] = [];
  if (c.minDaysAhead != null) out.push(tr.p("offerBookAhead", c.minDaysAhead));
  if (c.maxDaysAhead != null) out.push(tr.p("offerBookWithin", c.maxDaysAhead));
  if (c.minNights != null) out.push(tr.p("offerMinNights", c.minNights));
  if (c.stayFrom && c.stayTo) {
    out.push(
      tr.t("offerStaysBetween", { from: offerDate(c.stayFrom, tr), to: offerDate(c.stayTo, tr) }),
    );
  } else if (c.stayFrom) {
    out.push(tr.t("offerStaysFrom", { from: offerDate(c.stayFrom, tr) }));
  } else if (c.stayTo) {
    out.push(tr.t("offerStaysUntil", { to: offerDate(c.stayTo, tr) }));
  }
  return out.length ? out : [tr.t("offerAnyStay")];
}

/**
 * When the offer can be had — the equivalent of the room page's availability
 * panel, and the reason this page is worth having.
 *
 * Only the lines that say something: an offer bookable today for any stay has a
 * status and nothing else, and printing "earliest stay: today" under it would be
 * noise dressed as detail.
 */
function OfferAvailability({
  offer,
  tr,
  today,
}: {
  offer: OfferView;
  tr: Translator;
  today: string;
}) {
  const s = useSlots();
  const rows: string[] = [];
  if (offer.earliestCheckin > today) {
    rows.push(tr.t("offerEarliestStay", { date: offerDate(offer.earliestCheckin, tr) }));
  }
  if (offer.bookBy) rows.push(tr.t("offerBookBy", { date: offerDate(offer.bookBy, tr) }));

  return (
    <div className={cx("mt-auto border-t pt-3", s.rule)}>
      <div className="text-label font-semibold uppercase tracking-wide text-muted-2">
        {tr.t("offerAvailability")}
      </div>
      <div className="mt-1 text-body font-semibold">
        {offer.status === "live"
          ? tr.t("offerStatusLive")
          : // An upcoming offer always has a bookFrom — that date is what makes it
            // upcoming rather than live.
            tr.t("offerStatusUpcoming", { date: offerDate(offer.bookFrom ?? offer.earliestCheckin, tr) })}
      </div>
      {rows.map((line) => (
        <div key={line} className="mt-0.5 text-caption text-muted">
          {line}
        </div>
      ))}
    </div>
  );
}

/** One offer. `cta` is the caller's: the section sends guests to the offers page
 *  for the detail, the offers page sends them to the search with the offer's
 *  earliest date (and its code) already filled in. */
export function OfferCard({
  offer,
  tr,
  currency,
  today,
  cta,
}: {
  offer: OfferView;
  tr: Translator;
  currency: string;
  today: string;
  cta?: { label: string; to: string };
}) {
  const s = useSlots();
  return (
    <div
      // Anchored so the home section's cards can link straight to this offer on
      // the full page. scroll-mt clears the sticky header, as the sections do.
      id={`offer-${offer.id}`}
      className={cx("flex scroll-mt-24 flex-col overflow-hidden p-5", s.panel)}
    >
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <span className="rounded-chip bg-accent-soft px-2.5 py-1 text-caption font-semibold text-accent-deep">
          {offerHeadline(offer, tr, currency)}
        </span>
        <span className="text-caption text-muted-2">
          {offer.trigger === "auto"
            ? tr.t("offerAutomatic")
            : // The code is the instruction, so it's set apart from the sentence
              // around it — a guest has to copy this exactly.
              tr.t("offerUseCode", { code: offer.code ?? "" })}
        </span>
      </div>

      <h3 className={cx("mb-2.5", s.h3)}>{offer.name}</h3>

      <ul className="mb-4 flex flex-col gap-1.5">
        {offerRules(offer, tr).map((line) => (
          <li key={line} className="flex items-start gap-2.5 text-body leading-[1.5] text-secondary">
            <Diamond className="mt-[6px]" size={7} />
            {line}
          </li>
        ))}
      </ul>

      <OfferAvailability offer={offer} tr={tr} today={today} />

      {cta && (
        <Link
          to={cta.to}
          className={cx(
            "mt-4 inline-block self-start",
            s.linkOutline,
            "px-4 py-2 text-body font-semibold text-accent hover:bg-accent-soft",
          )}
        >
          {cta.label}
        </Link>
      )}
    </div>
  );
}

export function OffersSection({
  section,
  tr,
  offers,
  today,
}: {
  section: SiteSection & { text?: Record<string, string> };
  tr: Translator;
  offers: OfferView[];
  today: string;
}) {
  const base = useBase();
  const s = useSlots();
  const { currency } = useProperty();
  const limit = numberSetting(section, "limit", 3);
  const shown = offers.slice(0, limit);
  // No offers, no section. A hotel that hasn't set a promotion up — or whose
  // last one has run its course — gets no empty heading on their home page.
  if (!shown.length) return null;
  const intro = section.text?.intro?.trim();

  return (
    <div className={cx(s.gap, "scroll-mt-24")} id="offers">
      <SectionH2 gap="mb-2">{sectionHeading(section, tr)}</SectionH2>
      {intro && (
        <div className={cx("mb-5 max-w-[620px]", s.headingAlign && "mx-auto")}>
          <RichText text={intro} className="text-body-lg leading-[1.6] text-muted" />
        </div>
      )}
      <div className={cx("grid", s.offersGrid, !intro && "mt-5")}>
        {shown.map((offer) => (
          <OfferCard
            key={offer.id}
            offer={offer}
            tr={tr}
            currency={currency}
            today={today}
            // The card's own booking CTA lives on the offers page, not here: the
            // home page IS the search form, so a "check dates" link that scrolled
            // 400px up would look broken. This goes to the offer's full entry.
            cta={{ label: tr.t("secOffersCta"), to: `${base}/offers#offer-${offer.id}` }}
          />
        ))}
      </div>
      {offers.length > shown.length && (
        <div className={cx("mt-5", s.headingAlign && "text-center")}>
          <Link
            to={`${base}/offers`}
            className="text-body font-semibold text-accent hover:underline"
          >
            {tr.t("offersAllCta", { n: offers.length })}
          </Link>
        </div>
      )}
    </div>
  );
}
