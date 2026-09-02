// Guest voucher shop — every active voucher product, eCommerce-style. Reached
// from the property header ("Gift vouchers") or a shared link.
import { Link } from "react-router";

import type { Route } from "./+types/vouchers";
import { pageMeta } from "~/lib/page-meta";
import { useProperty } from "~/lib/booking-context";
import { useT } from "~/lib/i18n";
import { formatMoney } from "~/lib/money";

import { getActiveVoucherProducts, soldCount } from "~/lib/vouchers.server";
import { useBase } from "~/lib/base";
import { resolveRequestProperty } from "~/lib/property-scope.server";
import { useSlots } from "~/components/site-style";
import { cx } from "~/lib/site-style";

export async function loader({ params, request }: Route.LoaderArgs) {
  const pid = await resolveRequestProperty(params.channelId, request);
  const products = await getActiveVoucherProducts(pid);
  // Loader data serializes into the page HTML — return a strict public
  // projection (no caps, no positions).
  const out = [];
  for (const p of products) {
    const soldOut = p.cap != null && (await soldCount(pid, p.id).catch(() => 0)) >= p.cap;
    out.push({
      id: p.id,
      kind: p.kind,
      title: p.title,
      description: p.description,
      image: p.image,
      price: p.price,
      value: p.kind === "gift" ? (p.value ?? p.price) : undefined,
      nights: p.package?.nights,
      adults: p.package?.adults,
      children: p.package?.children,
      guests: p.kind === "experience" ? p.guests : undefined,
      soldOut,
    });
  }
  return { products: out };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageMeta(matches, { titleKey: "metaVouchers", descKey: "metaDescVouchers" });
}

export default function Vouchers({ loaderData, params }: Route.ComponentProps) {
  const base = useBase();
  const { products } = loaderData;
  const { currency, hotelName } = useProperty();
  const tr = useT();
  const s = useSlots();
  const money = (n: number) => formatMoney(n, currency);
  const stripe = "repeating-linear-gradient(135deg,#efe7da,#efe7da 12px,#e7ddcc 12px,#e7ddcc 24px)";

  return (
    <main className="mx-auto max-w-[1160px] px-7 pb-[72px] pt-12">
      <div className="mb-9 max-w-[620px]">
        <h1 className="mb-3 font-serif text-display-lg font-medium tracking-[-0.02em]">{tr.t("vouchersTitle")}</h1>
        <p className="text-lead leading-[1.6] text-secondary">{tr.t("vouchersIntro", { hotel: hotelName })}</p>
      </div>

      {products.length === 0 ? (
        <div className={cx(s.card, "p-8 text-body-lg text-secondary")}>
          {tr.t("vouchersEmpty")}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => (
            <Link
              key={p.id}
              to={`${base}/vouchers/${p.id}`}
              className={cx("group overflow-hidden", s.panel, "transition-shadow hover:shadow-md")}
            >
              {/* No image, no frame. A 170px striped block above the only product
                  on the page read as a broken image rather than a design. */}
              {p.image && (
                <div className="h-[170px] overflow-hidden" style={{ background: stripe }}>
                  <img
                    src={p.image}
                    alt=""
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                  />
                </div>
              )}
              <div className="p-5">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="rounded-full bg-chip px-2.5 py-0.5 text-micro font-semibold text-muted">
                    {p.kind === "gift" ? tr.t("voucherKindGift") : p.kind === "package" ? tr.t("voucherKindPackage") : tr.t("voucherKindExperience")}
                  </span>
                  {p.soldOut && (
                    <span className="rounded-full bg-danger-soft px-2.5 py-0.5 text-micro font-semibold text-danger">
                      {tr.t("voucherSoldOut")}
                    </span>
                  )}
                </div>
                <h2 className="mb-1 font-serif text-title-md font-semibold">{p.title}</h2>
                <p className="mb-3 line-clamp-2 text-caption leading-[1.5] text-muted">{p.description}</p>
                <div className="flex items-baseline justify-between">
                  <span className="text-title-sm font-semibold text-accent-deep">{money(p.price)}</span>
                  <span className="text-label text-muted-2">
                    {p.kind === "gift"
                      ? tr.t("voucherValue", { amount: money(p.value ?? p.price) })
                      : p.kind === "experience"
                        ? p.guests
                          ? tr.p("voucherGuests", p.guests)
                          : tr.t("voucherAtHotel")
                        : `${tr.p("night", p.nights ?? 1)} · ${tr.p("adult", p.adults ?? 2)}${p.children ? ` + ${tr.p("child", p.children)}` : ""}`}
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
