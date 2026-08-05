// Website offers page — every promotion a guest can currently have, and when.
//
// The counterpart to the room page: that one answers "tell me about this room and
// show me when it's free", this one answers "what are the deals and when do they
// apply". Both work with no dates in the URL, and both hand off to the dated
// funnel once the guest has picked.
//
// What it does NOT do is show a per-date calendar. Whether an offer applies
// depends on the check-in date, the check-out date, the booking date and the
// number of nights at once — a grid of green days would have to pick one of those
// and be wrong about the rest. The rules are stated instead, alongside the dates
// they work out to today, and the CTA goes to the search where real availability
// lives.
//
// The page shell is the room page's, not the section renderer's: the templates'
// full-width bands supply their own gutters, and this page has no bands. Same
// choice every funnel and room page makes. The template still reaches it through
// the slots and tokens the cards use.

import { Link } from "react-router";

import type { Route } from "./+types/offers";
import { OfferCard } from "~/components/offers-section";
import { useBase } from "~/lib/base";
import { useProperty } from "~/lib/booking-context";
import { todayISODate } from "~/lib/dates";
import { useT } from "~/lib/i18n";
import { getSettings } from "~/lib/overrides.server";
import { pageMeta } from "~/lib/page-meta";
import { getPublicOffers } from "~/lib/promotions.server";
import { resolveRequestProperty } from "~/lib/property-scope.server";
import { useSlots } from "~/components/site-style";
import { cx } from "~/lib/site-style";

export async function loader({ params, request }: Route.LoaderArgs) {
  const pid = await resolveRequestProperty(params.channelId, request);
  const settings = await getSettings(pid);
  // Part of the website layer, like the room page. With it off there's no website
  // for this to belong to, so the URL shouldn't exist rather than serve an orphan.
  if (!settings.websiteEnabled) throw new Response("Not Found", { status: 404 });

  return {
    offers: await getPublicOffers(pid),
    // The same date the cards compare against, decided once on the server so the
    // markup can't change on hydration.
    today: todayISODate(),
  };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageMeta(matches, { titleKey: "metaOffers", descKey: "metaDescOffers" });
}

export default function OffersPage({ loaderData }: Route.ComponentProps) {
  const { offers, today } = loaderData;
  const { currency } = useProperty();
  const base = useBase();
  const tr = useT();
  const s = useSlots();

  return (
    <main className="mx-auto max-w-[1160px] px-7 pb-[72px] pt-10">
      <Link
        to={base}
        className="mb-6 inline-flex items-center gap-1.5 text-body font-semibold text-muted hover:text-accent"
      >
        ‹ {tr.t("backToHome")}
      </Link>

      <h1 className={cx(s.h1, s.headingAlign)}>{tr.t("offersTitle")}</h1>
      <p
        className={cx(
          "mt-3.5 max-w-[620px] text-lead leading-[1.6] text-secondary",
          s.headingAlign && "mx-auto",
        )}
      >
        {tr.t("offersIntro")}
      </p>

      {offers.length === 0 ? (
        <div className={cx("mt-9 max-w-[620px]", s.card, "p-6 text-body-lg text-secondary")}>
          {tr.t("offersEmpty")}
        </div>
      ) : (
        <div className={cx("mt-9 grid", s.offersGrid)}>
          {offers.map((offer) => (
            <OfferCard
              key={offer.id}
              offer={offer}
              tr={tr}
              currency={currency}
              today={today}
              // Every offer gets a page, including one that isn't open yet — the
              // page is where the dates and the calendar are, and for an upcoming
              // offer it explains why there's nothing to book instead of dropping
              // the guest into a search that would miss the discount.
              cta={{ label: tr.t("offerBookCta"), to: `${base}/offers/${offer.id}` }}
            />
          ))}
        </div>
      )}
    </main>
  );
}
