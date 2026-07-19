// Voucher product detail + purchase — the "experience gift page". Marketing-
// style layout from the design handoff: hero gallery, facts strip, what's-
// included grid, room cards, FAQ accordion, and a sticky purchase panel.
// Live sales go through Stripe Checkout (pending stash → hosted payment →
// finalize on return/webhook, exactly like bookings); test mode issues a
// simulated voucher directly.
import { useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/voucher-buy";
import { Lightbox } from "~/components/lightbox";
import { useProperty } from "~/lib/booking-context";
import { useT } from "~/lib/i18n";
import { formatMoney } from "~/lib/money";
import { getConfig } from "~/lib/config.server";
import { resolvePropertyId } from "~/lib/properties.server";
import { getOverrides, getSettings } from "~/lib/overrides.server";
import { getRooms } from "~/lib/catalog.server";
import { computeExpiry, voucherCode, WEEKDAY_LABELS, type VoucherRecord } from "~/lib/vouchers";
import { getVoucherProduct, soldCount } from "~/lib/vouchers.server";
import { generateReference } from "~/lib/bookings.server";
import { stashPendingVoucher, type PendingVoucher } from "~/lib/pending-vouchers.server";
import { finalizeVoucher } from "~/lib/voucher-purchase.server";
import { createCheckoutSession } from "~/lib/stripe.server";

export async function loader({ params }: Route.LoaderArgs) {
  const pid = await resolvePropertyId(params.channelId);
  const product = await getVoucherProduct(pid, params.productId);
  if (!product || !product.active) throw redirect(`/${params.channelId}/vouchers`);
  const soldOut = product.cap != null && (await soldCount(pid, product.id).catch(() => 0)) >= product.cap;

  // Rooms feed the gallery + "where you'll stay" cards: a package shows its
  // allowed room types, a gift voucher shows the hotel's rooms in general.
  const rooms = product.kind === "experience" ? [] : await getRooms(pid).catch(() => []);
  const relevant = product.package ? rooms.filter((r) => product.package!.roomIds.includes(r.id)) : rooms;
  const roomTitles = product.package ? relevant.map((r) => r.title) : [];

  const gallery: string[] = [];
  for (const src of [product.image, ...relevant.flatMap((r) => r.images)]) {
    if (src && !gallery.includes(src) && gallery.length < 8) gallery.push(src);
  }

  // Strict public projection (loader data serializes into the HTML).
  return {
    product: {
      id: product.id,
      kind: product.kind,
      title: product.title,
      description: product.description,
      price: product.price,
      value: product.kind === "gift" ? (product.value ?? product.price) : undefined,
      expiresMonths: product.expiresMonths,
      terms: product.terms,
      included: product.included ?? [],
      guests: product.guests,
      package: product.package
        ? {
            nights: product.package.nights,
            adults: product.package.adults,
            children: product.package.children,
            checkinDays: product.package.checkinDays,
            window: product.package.window,
          }
        : undefined,
      roomTitles,
    },
    gallery,
    roomCards: relevant.slice(0, 3).map((r) => ({
      name: r.title,
      desc: r.description ?? "",
      img: r.images[0],
    })),
    soldOut,
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const pid = await resolvePropertyId(params.channelId);
  const product = await getVoucherProduct(pid, params.productId);
  if (!product || !product.active) return { error: "This voucher is no longer on sale." };
  if (product.cap != null && (await soldCount(pid, product.id)) >= product.cap) {
    return { error: "Sold out — this voucher is no longer available." };
  }

  const form = await request.formData();
  const buyerName = String(form.get("buyerName") ?? "").trim();
  const buyerEmail = String(form.get("buyerEmail") ?? "").trim();
  const isGift = form.get("isGift") != null;
  const recipientName = String(form.get("recipientName") ?? "").trim();
  const recipientEmail = String(form.get("recipientEmail") ?? "").trim();
  const message = String(form.get("message") ?? "").trim();

  if (!buyerName) return { error: "Enter your name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) return { error: "Enter a valid email address." };
  if (isGift && !recipientName) return { error: "Enter the recipient's name." };
  if (isGift && recipientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
    return { error: "The recipient's email doesn't look valid." };
  }
  if (product.terms && form.get("agree") == null) return { error: "Please agree to the voucher terms." };

  const [settings, config] = [await getSettings(pid), getConfig()];
  const live = Boolean(settings.liveBooking ?? config.allowLiveBooking);
  const stripeAccount = settings.stripeAccountId as string | undefined;
  if (live && !stripeAccount) {
    return { error: "Online payment isn't set up for this property yet — vouchers can't be sold." };
  }

  // Room names frozen into the snapshot for display on the voucher/PDF.
  let roomTitles: string[] | undefined;
  if (product.package) {
    const rooms = await getRooms(pid).catch(() => []);
    roomTitles = product.package.roomIds
      .map((id) => rooms.find((r) => r.id === id)?.title)
      .filter((t): t is string => Boolean(t));
  }

  const now = new Date().toISOString();
  const record: Omit<VoucherRecord, "payment"> = {
    id: crypto.randomUUID(),
    code: voucherCode(),
    kind: product.kind,
    productId: product.id,
    product: {
      title: product.title,
      description: product.description,
      image: product.image,
      price: product.price,
      value: product.kind === "gift" ? (product.value ?? product.price) : undefined,
      terms: product.terms,
      included: product.included,
      guests: product.guests,
      package: product.package,
      roomTitles,
    },
    buyer: { name: buyerName, email: buyerEmail },
    gift: isGift ? { recipientName, recipientEmail: recipientEmail || undefined, message: message || undefined } : undefined,
    purchasedAt: now,
    expiresAt: computeExpiry(now, product.expiresMonths),
    status: "active",
    balance: product.kind === "gift" ? (product.value ?? product.price) : undefined,
    redemptions: [],
  };

  const url = new URL(request.url);
  const pending: PendingVoucher = {
    pid,
    account: stripeAccount ?? "",
    record,
    live,
    channel: params.channelId,
    origin: url.origin,
  };

  if (!live) {
    // Test mode: issue a simulated voucher directly — same as simulated bookings.
    const issued = await finalizeVoucher(pending, undefined);
    return redirect(`/${params.channelId}/voucher/${issued.code}?issued=1`);
  }

  const reference = generateReference();
  await stashPendingVoucher(reference, pending);
  const currency = settings.currency || "GBP";
  const amountMinor = Math.round(product.price * 100);
  const feeBps = config.stripePlatformFeeBps;
  const hotelName = (await getOverrides(pid)).hotelName || "Your hotel";
  let sessionUrl: string | undefined;
  try {
    const session = await createCheckoutSession(
      stripeAccount!,
      {
        client_reference_id: reference,
        customer_email: buyerEmail,
        metadata: { kind: "voucher", reference, pid },
        // Same 60-min payment window inside the 3h pending stash as bookings.
        expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
        success_url: `${url.origin}/${params.channelId}/vouchers/complete?session_id={CHECKOUT_SESSION_ID}&ref=${reference}`,
        cancel_url: `${url.origin}/${params.channelId}/vouchers/${product.id}`,
        mode: "payment",
        payment_intent_data: {
          description: `${hotelName} voucher · ${product.title} (${record.code})`,
          metadata: { kind: "voucher", reference, pid },
          ...(feeBps > 0 ? { application_fee_amount: Math.round((amountMinor * feeBps) / 10000) } : {}),
        },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: currency.toLowerCase(),
              unit_amount: amountMinor,
              product_data: {
                name: `${hotelName} — ${product.title}`,
                description:
                  product.kind === "gift"
                    ? `Gift voucher worth ${formatMoney(product.value ?? product.price, currency)}.`
                    : product.description || "Stay package voucher.",
              },
            },
          },
        ],
      },
      reference,
    );
    sessionUrl = session.url;
  } catch (e) {
    console.log(`[vouchers] stripe session failed for pid=${pid}: ${e instanceof Error ? e.message : e}`);
    return { error: "The payment couldn't be started — please try again." };
  }
  if (!sessionUrl) return { error: "The payment couldn't be started — please try again." };
  throw redirect(sessionUrl);
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData?.product.title ?? "Voucher" }];
}

/** The rotated-square brand motif, used as eyebrow accent and list bullet. */
function Diamond({ size, className = "" }: { size: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block flex-none rounded-[1px] bg-accent ${className}`}
      style={{ width: size, height: size, transform: "rotate(45deg)" }}
    />
  );
}

/** Single-open FAQ accordion ("Good to know"): + icon rotates 45°, the answer
 *  panel animates via max-height. */
function Faq({ items }: { items: { q: string; a: string }[] }) {
  const [open, setOpen] = useState(0);
  return (
    <div className="overflow-hidden rounded-[16px] border border-line bg-surface-alt">
      {items.map((item, i) => (
        <div key={i} className={i === 0 ? "" : "border-t border-divider"}>
          <button
            type="button"
            onClick={() => setOpen(open === i ? -1 : i)}
            className="flex w-full items-center justify-between gap-4 px-[22px] py-[19px] text-left"
          >
            <span className="text-[16px] font-semibold text-ink">{item.q}</span>
            <span
              className="flex-none text-[22px] leading-none text-accent transition-transform duration-200"
              style={{ transform: open === i ? "rotate(45deg)" : "rotate(0deg)" }}
            >
              +
            </span>
          </button>
          <div
            className="overflow-hidden transition-[max-height] duration-300 ease-in-out"
            style={{ maxHeight: open === i ? "300px" : "0px" }}
          >
            <p className="m-0 max-w-[64ch] px-[22px] pb-5 text-[15px] leading-[1.6] text-secondary">{item.a}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function VoucherBuy({ loaderData, actionData, params }: Route.ComponentProps) {
  const { product: p, gallery, roomCards, soldOut } = loaderData;
  const { currency } = useProperty();
  const tr = useT();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const [isGift, setIsGift] = useState(false);
  const [formOpen, setFormOpen] = useState(Boolean(actionData?.error));
  const [lightbox, setLightbox] = useState<number | null>(null);
  const money = (n: number) => formatMoney(n, currency);
  const stripe = "repeating-linear-gradient(135deg,#efe7da,#efe7da 12px,#e7ddcc 12px,#e7ddcc 24px)";
  const input =
    "mt-1.5 block w-full rounded-[10px] border border-line-alt bg-surface px-3.5 py-2.5 text-[15px] text-ink outline-none focus:border-accent";

  const pkg = p.package;
  const pkgGuests = pkg ? pkg.adults + (pkg.children ?? 0) : 0;

  const facts: { label: string; value: string }[] = pkg
    ? [
        { label: tr.t("voucherFactDuration"), value: tr.p("night", pkg.nights) },
        { label: tr.t("voucherFactGuests"), value: tr.p("voucherGuests", pkgGuests) },
        {
          label: tr.t("voucherFactCheckin"),
          value: pkg.checkinDays.length ? pkg.checkinDays.map((d) => WEEKDAY_LABELS[d]).join(" / ") : tr.t("voucherAnyDay"),
        },
        {
          label: tr.t("voucherFactWindow"),
          value: pkg.window?.from || pkg.window?.to ? `${pkg.window.from ?? "…"} – ${pkg.window.to ?? "…"}` : tr.t("voucherAllYear"),
        },
      ]
    : p.kind === "experience"
      ? [
          ...(p.guests ? [{ label: tr.t("voucherFactGuests"), value: tr.p("voucherGuests", p.guests) }] : []),
          { label: tr.t("voucherFactValidity"), value: tr.t("voucherMonthsShort", { n: String(p.expiresMonths) }) },
          { label: tr.t("voucherFactDelivery"), value: tr.t("voucherInstantEmail") },
          { label: tr.t("voucherFactRedeem"), value: tr.t("voucherAtHotel") },
        ]
      : [
          { label: tr.t("voucherFactValue"), value: money(p.value ?? p.price) },
          { label: tr.t("voucherFactValidity"), value: tr.t("voucherMonthsShort", { n: String(p.expiresMonths) }) },
          { label: tr.t("voucherFactDelivery"), value: tr.t("voucherInstantEmail") },
        ];

  const faqs: { q: string; a: string }[] = [
    { q: tr.t("voucherFaqDeliveryQ"), a: tr.t("voucherFaqDeliveryA") },
    pkg
      ? { q: tr.t("voucherFaqBookQ"), a: tr.t("voucherFaqBookA") }
      : p.kind === "experience"
        ? { q: tr.t("voucherFaqRedeemQ"), a: tr.t("voucherFaqRedeemA") }
        : { q: tr.t("voucherFaqUseQ"), a: tr.t("voucherFaqUseA") },
    { q: tr.t("voucherFaqExpiryQ"), a: tr.t("voucherFaqExpiryA", { n: String(p.expiresMonths) }) },
    ...(p.terms ? [{ q: tr.t("voucherFaqTermsQ"), a: p.terms }] : []),
  ];

  const panelPoints = [
    tr.t("voucherPointDelivered"),
    pkg ? tr.t("voucherPointDates") : p.kind === "experience" ? tr.t("voucherPointRedeem") : tr.t("voucherPointSpend"),
    tr.t("voucherPointMessage"),
  ];
  const priceSub = pkg
    ? tr.t("voucherPriceForStay", { guests: tr.p("voucherGuests", pkgGuests), nights: tr.p("night", pkg.nights) })
    : p.kind === "experience"
      ? p.guests
        ? tr.t("voucherPriceForGuests", { guests: tr.p("voucherGuests", p.guests) })
        : tr.t("voucherValidFor", { n: String(p.expiresMonths) })
      : tr.t("voucherValue", { amount: money(p.value ?? p.price) });

  const galleryPhotos = gallery.map((url) => ({ url }));
  const openForm = (gift: boolean) => {
    setIsGift(gift);
    setFormOpen(true);
  };

  const primaryBtn =
    "w-full rounded-[12px] bg-accent px-6 py-[15px] text-[16px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:opacity-60";
  const outlineBtn =
    "w-full rounded-[12px] border border-line-alt bg-transparent px-6 py-[13px] text-[15px] font-semibold text-secondary transition-colors hover:bg-chip";

  return (
    <main className="mx-auto max-w-[1160px] px-7 pb-24 pt-6 min-[900px]:pb-20">
      {/* Breadcrumb */}
      <div className="mb-4 flex items-center gap-2 text-[13px] text-muted-2">
        <Link to={`/${params.channelId}/vouchers`} className="hover:text-accent">
          {tr.t("vouchersTitle")}
        </Link>
        <span>›</span>
        <span className="text-secondary">{p.title}</span>
      </div>

      {/* Hero gallery: one large image spanning two rows + two stacked. */}
      {gallery.length > 0 ? (
        <section
          className={`mb-6 grid gap-3 overflow-hidden rounded-[22px] ${gallery.length >= 3 ? "grid-cols-[2fr_1fr] grid-rows-2" : gallery.length === 2 ? "grid-cols-[2fr_1fr]" : ""}`}
          style={{ height: "clamp(300px, 42vw, 460px)" }}
        >
          {gallery.slice(0, 3).map((src, i) => {
            const last = i === Math.min(gallery.length, 3) - 1;
            return (
              <button
                key={src}
                type="button"
                onClick={() => setLightbox(i)}
                className={`relative overflow-hidden bg-line ${i === 0 && gallery.length >= 3 ? "row-span-2" : ""}`}
              >
                <img src={src} alt={i === 0 ? p.title : ""} className="h-full w-full object-cover" />
                {last && gallery.length > 1 && (
                  <span className="absolute bottom-3.5 right-3.5 rounded-full bg-ink/80 px-[15px] py-2 text-[13px] font-semibold text-page backdrop-blur-sm">
                    {tr.t("voucherPhotosCount", { n: String(gallery.length) })}
                  </span>
                )}
              </button>
            );
          })}
        </section>
      ) : (
        <div className="mb-6 h-[280px] rounded-[22px]" style={{ background: stripe }} />
      )}

      {/* Body: content + sticky purchase panel */}
      <div className="grid items-start gap-x-12 gap-y-8 min-[900px]:grid-cols-[minmax(0,1fr)_360px]">
        {/* LEFT column */}
        <div>
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-chip-border bg-chip px-[13px] py-1.5 text-[12.5px] font-semibold uppercase tracking-[0.06em] text-accent-deep">
            <Diamond size={7} />
            {p.kind === "gift" ? tr.t("voucherKindGift") : p.kind === "package" ? tr.t("voucherKindPackage") : tr.t("voucherKindExperience")}
          </div>
          <h1 className="m-0 mb-2.5 font-serif text-[clamp(30px,4.6vw,46px)] font-semibold leading-[1.06] tracking-[-0.02em]">
            {p.title}
          </h1>
          {(pkg || (p.kind === "experience" && p.guests)) && (
            <p className="mb-3.5 text-[16px] text-secondary">
              {tr.t("voucherForGuests", { n: String(pkg ? pkgGuests : p.guests) })}
            </p>
          )}
          {p.description && (
            <p className="mb-7 max-w-[60ch] text-[17px] leading-[1.6] text-secondary">{p.description}</p>
          )}

          {/* Facts strip — hairline dividers via 1px gaps over the border color */}
          <div
            className="mb-10 grid gap-px overflow-hidden rounded-[16px] border border-line bg-line"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))" }}
          >
            {facts.map((f) => (
              <div key={f.label} className="bg-surface-alt px-[18px] pb-4 pt-[18px]">
                <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.1em] text-muted-2">{f.label}</div>
                <div className="font-serif text-[20px] font-semibold tracking-[-0.01em]">{f.value}</div>
              </div>
            ))}
          </div>

          {/* What's included */}
          {p.included.length > 0 && (
            <section id="included" className="mb-11 scroll-mt-[90px]">
              <h2 className="m-0 mb-5 font-serif text-[28px] font-semibold tracking-[-0.01em]">
                {tr.t("voucherIncludedTitle")}
              </h2>
              <div className="grid gap-x-7 gap-y-3.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
                {p.included.map((item) => (
                  <div key={item} className="flex items-start gap-3 py-0.5">
                    <Diamond size={8} className="mt-[7px]" />
                    <span className="text-[16px] leading-[1.5] text-ink">{item}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Where you'll stay — the package's room types (or the hotel's rooms) */}
          {roomCards.length > 0 && (
            <section className="mb-11">
              <h2 className="m-0 mb-5 font-serif text-[28px] font-semibold tracking-[-0.01em]">
                {tr.t("voucherWhereYoullStay")}
              </h2>
              <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                {roomCards.map((r) => (
                  <div key={r.name} className="overflow-hidden rounded-[18px] border border-line bg-surface-alt">
                    {r.img && (
                      <div className="h-[150px] overflow-hidden bg-line">
                        <img src={r.img} alt={r.name} className="h-full w-full object-cover" />
                      </div>
                    )}
                    <div className="px-[18px] pb-5 pt-[18px]">
                      <div className="mb-1.5 font-serif text-[21px] font-semibold tracking-[-0.01em]">{r.name}</div>
                      {r.desc && <div className="line-clamp-3 text-[14.5px] leading-[1.55] text-secondary">{r.desc}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Good to know */}
          <section id="faq" className="scroll-mt-[90px]">
            <h2 className="m-0 mb-[18px] font-serif text-[28px] font-semibold tracking-[-0.01em]">
              {tr.t("voucherFaqTitle")}
            </h2>
            <Faq items={faqs} />
          </section>
        </div>

        {/* RIGHT: sticky purchase panel */}
        <aside id="buy" className="scroll-mt-[88px] min-[900px]:sticky min-[900px]:top-[88px]">
          <div
            className="overflow-hidden rounded-[20px] border border-line-alt bg-surface-alt"
            style={{ boxShadow: "0 24px 60px -34px rgba(70,55,35,0.45)" }}
          >
            <div className="p-6 pb-[22px]">
              {soldOut ? (
                <p className="m-0 text-[15px] font-semibold text-[#c0392b]">{tr.t("voucherSoldOut")}</p>
              ) : (
                <>
                  <div className="mb-0.5 flex items-baseline gap-2">
                    <span className="font-serif text-[40px] font-semibold leading-none tracking-[-0.01em]">
                      {money(p.price)}
                    </span>
                  </div>
                  <div className="mb-5 text-[14px] text-secondary">{priceSub}</div>

                  <div className="mb-[18px] flex flex-col gap-2.5">
                    {panelPoints.map((pt) => (
                      <div key={pt} className="flex items-start gap-2.5">
                        <Diamond size={6} className="mt-[6px]" />
                        <span className="text-[14.5px] leading-[1.45] text-secondary">{pt}</span>
                      </div>
                    ))}
                  </div>

                  {!formOpen ? (
                    <>
                      <button type="button" onClick={() => openForm(false)} className={primaryBtn}>
                        {tr.t("voucherBuy", { amount: money(p.price) })} →
                      </button>
                      <button type="button" onClick={() => openForm(true)} className={`${outlineBtn} mt-2.5`}>
                        {tr.t("voucherAddMessage")}
                      </button>
                    </>
                  ) : (
                    <Form method="post" className="flex flex-col gap-4 border-t border-divider pt-4">
                      <h2 className="m-0 font-serif text-[20px] font-semibold">{tr.t("voucherYourDetails")}</h2>
                      <label className="block text-[13px] font-semibold text-secondary">
                        {tr.t("buyerName")}
                        <input name="buyerName" required className={input} />
                      </label>
                      <label className="block text-[13px] font-semibold text-secondary">
                        {tr.t("buyerEmail")}
                        <input name="buyerEmail" type="email" required className={input} />
                      </label>

                      <label className="flex items-center gap-2.5 text-[14px] font-semibold">
                        <input
                          type="checkbox"
                          name="isGift"
                          checked={isGift}
                          onChange={(e) => setIsGift(e.target.checked)}
                          className="h-4 w-4 rounded border-line-alt text-accent focus:ring-accent"
                        />
                        {tr.t("voucherIsGift")}
                      </label>
                      {isGift && (
                        <>
                          <label className="block text-[13px] font-semibold text-secondary">
                            {tr.t("recipientName")}
                            <input name="recipientName" className={input} />
                          </label>
                          <label className="block text-[13px] font-semibold text-secondary">
                            {tr.t("recipientEmail")}
                            <input name="recipientEmail" type="email" className={input} />
                            <span className="mt-1 block text-[11.5px] font-normal text-faint">
                              {tr.t("recipientEmailHint")}
                            </span>
                          </label>
                          <label className="block text-[13px] font-semibold text-secondary">
                            {tr.t("giftMessage")}
                            <textarea name="message" rows={2} maxLength={400} className={`${input} resize-y`} />
                          </label>
                        </>
                      )}

                      {p.terms && (
                        <label className="flex items-start gap-2.5 text-[13px] text-secondary">
                          <input
                            type="checkbox"
                            name="agree"
                            className="mt-0.5 h-4 w-4 rounded border-line-alt text-accent focus:ring-accent"
                          />
                          {tr.t("voucherAgreeTerms")}
                        </label>
                      )}

                      {actionData?.error && <p className="m-0 text-[13px] text-red-600">{actionData.error}</p>}
                      <button type="submit" disabled={busy} className={primaryBtn}>
                        {busy ? "…" : tr.t("voucherBuy", { amount: money(p.price) })}
                      </button>
                    </Form>
                  )}

                  <div className="mt-4 flex items-center justify-center gap-2 text-[13px] text-muted-2">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: "oklch(0.7 0.13 150)" }} />
                    {tr.t("voucherTrustLine", { n: String(p.expiresMonths) })}
                  </div>
                </>
              )}
            </div>
            <div className="flex items-center gap-2.5 border-t border-divider bg-chip px-6 py-3.5 text-[13.5px] text-secondary">
              <Diamond size={7} />
              {pkg ? tr.t("voucherStripDates") : p.kind === "experience" ? tr.t("voucherStripExperience") : tr.t("voucherStripBalance")}
            </div>
          </div>
        </aside>
      </div>

      {/* Mobile buy bar */}
      {!soldOut && (
        <div
          className="fixed bottom-0 left-0 right-0 z-30 flex items-center justify-between gap-3.5 border-t border-line-alt px-5 py-3 min-[900px]:hidden"
          style={{
            background: "color-mix(in oklab, var(--color-surface-alt) 96%, transparent)",
            backdropFilter: "blur(10px)",
            boxShadow: "0 -12px 30px -20px rgba(70,55,35,0.4)",
          }}
        >
          <div>
            <div className="font-serif text-[24px] font-semibold leading-none">{money(p.price)}</div>
            <div className="text-[12.5px] text-muted-2">{priceSub}</div>
          </div>
          <a
            href="#buy"
            onClick={() => setFormOpen(true)}
            className="flex-none rounded-[11px] bg-accent px-6 py-3 text-[15px] font-semibold text-white hover:bg-accent-deep"
          >
            {tr.t("voucherBuy", { amount: money(p.price) })}
          </a>
        </div>
      )}

      <Lightbox
        photos={galleryPhotos}
        index={lightbox}
        title={p.title}
        tr={tr}
        onChange={setLightbox}
        onClose={() => setLightbox(null)}
      />
    </main>
  );
}
