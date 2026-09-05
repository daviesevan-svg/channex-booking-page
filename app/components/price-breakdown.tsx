// The guest-facing price itemisation: extras (grouped per room), then the
// charge and tax lines, then the all-in total and the "includes taxes" note.
// Checkout and confirmation each hand-rolled this and drifted — the SAME
// booking was itemised in a different section order on two consecutive
// screens (confirmation listed extras after the taxes). One implementation,
// one order; the `variant` keeps each page's existing type scale.
import { groupExtrasByRoom, type ResolvedExtra } from "~/lib/extras";
import { formatMoney, formatMoneyParts } from "~/lib/money";
import { offerScope, priceSpecScope } from "~/lib/nav-tags";
import type { Pricing } from "~/lib/pricing";
import { useT } from "~/lib/i18n";
import { useSlots } from "~/components/site-style";
import { cx } from "~/lib/site-style";

/**
 * The grand total, wrapped in the Offer microdata Google's price-accuracy
 * crawler extracts.
 *
 * The number is the only part inside `itemprop="price"` — the currency symbol
 * sits outside it, and the ISO code goes in a <meta> — because a symbol inside
 * the tagged text is one parser away from being read as part of the amount.
 * The visible text keeps its group separators (it has to: this IS the price the
 * guest is shown), so the unseparated value rides in `content` alongside it.
 * Google explicitly does NOT accept a total that is only in a <meta>; this
 * renders the same characters formatMoney would have.
 */
function TaggedTotal({ amount, currency }: { amount: number; currency: string }) {
  const { before, number, after, value } = formatMoneyParts(amount, currency);
  return (
    <span {...offerScope}>
      <span {...priceSpecScope}>
        <meta itemProp="priceCurrency" content={currency} />
        {before}
        <span itemProp="price" content={value}>
          {number}
        </span>
        {after}
      </span>
    </span>
  );
}

export function PriceBreakdown({
  pricing,
  extraLines,
  grandTotal,
  currency,
  variant,
  /** Confirmation's degenerate reload (no cart in the URL) hides the money
   *  rows but keeps the layout; checkout always shows them. */
  showMoney = true,
  /** Tag the total as the schema.org Offer price Google's crawler reads.
   *
   * Opt-in rather than derived from `variant`, because it is a claim about the
   * PAGE, not about the layout: only the final page before payment may carry
   * an offer, and confirmation — same component, same numbers — is past it.
   * The enclosing Hotel/LodgingReservation scope is the caller's to provide.
   */
  offerMicrodata = false,
}: {
  pricing: Pick<Pricing, "charges" | "taxLines" | "taxIncluded">;
  extraLines: ResolvedExtra[];
  grandTotal: number;
  currency: string;
  variant: "checkout" | "confirmation";
  showMoney?: boolean;
  offerMicrodata?: boolean;
}) {
  const tr = useT();
  const s = useSlots();
  const co = variant === "checkout";

  const extras = groupExtrasByRoom(extraLines);
  const money = (n: number) => formatMoney(n, currency);

  const row = (key: string, label: string, value: string) => (
    <div key={key} className="flex justify-between">
      <span className="text-secondary">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );

  return (
    <>
      {extras.length > 0 && (
        <div className={co ? cx("flex flex-col gap-3 border-b", s.rule, "py-4 text-body") : "flex flex-col gap-3"}>
          {co && (
            <div className="text-label font-semibold uppercase tracking-wide text-muted-2">{tr.t("extrasLabel")}</div>
          )}
          {extras.map((g, gi) => (
            <div key={gi} className={co ? "flex flex-col gap-1.5" : "flex flex-col gap-1"}>
              <div className="text-label font-semibold text-secondary">{g.roomTitle ?? tr.t("forYourStay")}</div>
              {g.lines.map((l) => (
                <div key={`${l.id}-${l.optionId ?? ""}`} className="flex items-start justify-between gap-3 pl-2">
                  <div className="min-w-0">
                    <span className={co ? undefined : "text-secondary"}>
                      {l.optionName ? `${l.name} · ${l.optionName}` : l.name}
                      {l.qty > 1 ? ` ×${l.qty}` : ""}
                    </span>
                    {l.infoLine && <div className="text-label text-muted-2">{l.infoLine}</div>}
                  </div>
                  <span className="whitespace-nowrap font-semibold">{money(l.amount)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {showMoney && (pricing.charges.length > 0 || pricing.taxLines.length > 0) && (
        <div className={co ? cx("flex flex-col gap-2.5 border-b", s.rule, "py-4 text-body") : "flex flex-col gap-3"}>
          {pricing.charges.map((c, i) => row(`charge-${i}`, c.label, money(c.amount)))}
          {pricing.taxLines.map((c, i) => row(`tax-${i}`, c.label, money(c.amount)))}
        </div>
      )}

      {showMoney && (
        <div
          className={
            co
              ? "flex items-baseline justify-between pt-4"
              : cx("flex items-baseline justify-between border-t", s.rule, "pt-3")
          }
        >
          <span className={co ? "text-lead font-semibold" : "text-secondary"}>{tr.t("total")}</span>
          <span className={co ? "font-serif text-display-sm font-semibold" : "font-serif text-title-lg font-semibold"}>
            {offerMicrodata ? <TaggedTotal amount={grandTotal} currency={currency} /> : money(grandTotal)}
          </span>
        </div>
      )}
      {showMoney && pricing.taxIncluded > 0 && (
        <p className={co ? "pb-4 pt-1 text-right text-label text-muted-2" : "text-right text-label text-muted-2"}>
          {tr.t("includesTaxes", { amount: money(pricing.taxIncluded) })}
        </p>
      )}
    </>
  );
}
