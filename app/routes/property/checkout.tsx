import { format, parseISO } from "date-fns";

import { useState } from "react";
import { Form, Link, redirect, redirectDocument, useNavigation, useSearchParams } from "react-router";
import { jsonLdHtml } from "~/lib/jsonld";
import { z } from "zod";

import type { Route } from "./+types/checkout";
import { Trans } from "~/components/trans";
import { pageMeta } from "~/lib/page-meta";
import type { RoomWithRates } from "~/lib/channex/types";
import { displayStatus, giftBalance, normalizeVoucherCode } from "~/lib/vouchers";
import { holdGiftAmount, lookupVoucherGuarded, releaseGiftHold } from "~/lib/vouchers.server";
import { useProperty } from "~/lib/booking-context";
import {
  cartCoverage,
  cartCovers,
  parseCart,
  serializeCart,
  withinAvailability,
  type ResolvedLine,
} from "~/lib/cart";
import { canonicalCheckoutIntent, hashCheckoutIntent } from "~/lib/checkout-idem";
import {
  releaseCheckoutIntent,
  resolveWebCheckoutIntent,
  writeWebCheckoutIdem,
} from "~/lib/checkout-idem.server";
import { cancellationVaries, resolveBookingCancellation, resolveBookingPolicy } from "~/lib/policy.server";
import { dueNow } from "~/lib/policy-copy";
import { describePolicy } from "~/lib/rate-policy";
import { cancellationMessage, formatCancelDeadline } from "~/lib/cancellation";
import { consentGate, stayTotals } from "~/lib/checkout-totals";
import { resolveAppliedPromo } from "~/lib/promotions.server";
import { normalizeCode, type AppliedPromo } from "~/lib/promotions";
import { getActiveExtras } from "~/lib/extras.server";
import { parseExtrasState, resolveAllExtras, serializeExtrasState, type ExtraContextLine } from "~/lib/extras";
import { PriceBreakdown } from "~/components/price-breakdown";
import { getConfig } from "~/lib/config.server";
import { clientKey, rateLimit } from "~/lib/rate-limit.server";
import { taxConfigFrom } from "~/lib/pricing";
import { buildCheckoutSessionParams, createCheckoutSession, stripeLocale } from "~/lib/stripe.server";
import { createVivaOrder, toVivaMinor, vivaCheckoutUrl } from "~/lib/viva.server";
import { IYZICO_PLACEHOLDER_IDENTITY, initializeCheckoutForm } from "~/lib/iyzico.server";
import { activeGateway, canSaveCard } from "~/lib/payments.server";
import { stashPending, stashVivaOrder } from "~/lib/pending-bookings.server";
import { afterCommit, finalizeBooking } from "~/lib/booking-finalize.server";
import { preparePendingBooking } from "~/lib/booking-create.server";
import { reservationHotelJsonLd } from "~/lib/hotel-jsonld.server";
import { hotelReservationScope, navStage } from "~/lib/nav-tags";
import { formatMoney, toStripeMinor } from "~/lib/money";
import type { Occupancy } from "~/lib/occupancy";
import { makeTranslator, occLabel, useT } from "~/lib/i18n";
import { langFromRequest } from "~/lib/content";
import { getOverrides, getPageText, getPageTextRaw } from "~/lib/overrides.server";

import { getCatalogRooms, getStayInventory, resolveCartByOccupancy } from "~/lib/catalog.server";
import { useBase, useHome } from "~/lib/base";
import { requireDatedStay } from "~/lib/dated-stay.server";
import { isEuConsumerCountry, orderButtonLabel } from "~/lib/eu-consumer";
import { attributionFromCookies } from "~/lib/attribution";
import { cartTokenMap } from "~/lib/cart-tokens";
import { beginCheckoutEvent } from "~/lib/tracking";
import { isTagged } from "~/lib/tracking-settings";
import { TrackCart, TrackFunnel } from "~/components/tracking-events";
import { funnelContext, queueFunnelEvent, type FunnelContext } from "~/lib/funnel-analytics.server";
import { useSlots } from "~/components/site-style";
import { cx } from "~/lib/site-style";

interface Stay {
  channelId: string;
  checkin: string;
  checkout: string;
  currency: string;
  occ: Occupancy;
}

async function resolveStayCart(
  stay: Stay,
  url: URL,
): Promise<{ rooms: RoomWithRates[]; lines: ResolvedLine[] }> {
  // One ARI read for the page: the catalog below and every cart occupancy group
  // price the same stay, so they share this slice.
  const inventory = await getStayInventory(stay.channelId, stay.checkin, stay.checkout);
  const rooms = await getCatalogRooms(
    stay.channelId,
    {
      checkinDate: stay.checkin,
      checkoutDate: stay.checkout,
      currency: stay.currency,
      adults: stay.occ.adults,
      childrenAge: stay.occ.childrenAge,
    },
    { gate: true, inventory },
  );
  const lines = await resolveCartByOccupancy(
    stay.channelId,
    { checkin: stay.checkin, checkout: stay.checkout, currency: stay.currency },
    parseCart(url.searchParams),
    { adults: stay.occ.adults, childrenAge: stay.occ.childrenAge },
    inventory,
  );
  return { rooms, lines };
}

/** Each cart line's context for pricing its attached extras — per-room extras
 *  price for that room's occupancy. */
function extraContext(lines: ResolvedLine[]): ExtraContextLine[] {
  return lines.map((l) => ({
    roomId: l.roomId,
    rateId: l.rateId,
    roomTitle: l.roomTitle,
    guests: l.occupancy.adults + l.occupancy.children,
  }));
}

/** Derive the automatic offer baked into the resolved lines (per-line offer data
 *  set by resolveCartByOccupancy) plus each line's pre-discount price, so
 *  checkout can itemise the saving. */
function deriveOffer(lines: ResolvedLine[]) {
  let name = "";
  let percent = 0;
  let hasOffer = false;
  const view = lines.map((l) => {
    const originalTotal = l.originalTotal ?? l.total;
    if (l.offerName != null && l.offerPercent != null && originalTotal > l.total) {
      hasOffer = true;
      name = l.offerName;
      percent = l.offerPercent;
    }
    return { ...l, originalTotal };
  });
  const originalSubtotal = Math.round(view.reduce((s, l) => s + l.originalTotal, 0) * 100) / 100;
  const saleSubtotal = Math.round(lines.reduce((s, l) => s + l.total, 0) * 100) / 100;
  const offer: AppliedPromo | null = hasOffer
    ? { name, type: "percent", value: percent, discount: Math.round((originalSubtotal - saleSubtotal) * 100) / 100 }
    : null;
  // Stay-level, so any line carries the same list — read it off the first rather
  // than merging identical copies.
  const valueAdds = lines[0]?.valueAdds ?? [];
  return { offer, valueAdds, originalSubtotal, lines: view };
}

export async function loader({ params, request }: Route.LoaderArgs) {
  // requireDatedStay resolves a slug :channelId to the real id, which the stay
  // carries so every data lookup + the booking record use the UUID; redirects
  // and links keep params.channelId so the slug stays in the URL through the
  // flow. The currency is the property's — the URL's is never read (see the
  // helper: this is the charge path, a spoofed ?currency= must not survive).
  const { pid, base, url, checkin, checkout, occ, currency, nights, settings } =
    await requireDatedStay(params.channelId, request);
  const stay: Stay = { channelId: pid, checkin, checkout, currency, occ };

  const lang = langFromRequest(request);
  const { rooms, lines } = await resolveStayCart(stay, url);
  if (!cartCovers(lines, stay.occ) || !withinAvailability(parseCart(url.searchParams), rooms)) {
    throw redirect(`${base}/rooms?${url.searchParams.toString()}`);
  }

  const text = await getPageText(pid, "checkout", lang);
  // Art. 8(2) CRD / § 312j(3) BGB: in the EU the order button has to say that
  // it costs money, and "Complete booking" doesn't. The hotel's OWN wording
  // always wins — we only replace our default, which is why this reads the raw
  // overrides rather than the merged text (see getPageTextRaw).
  const euConsumer = isEuConsumerCountry(settings.addressCountry);
  if (euConsumer) {
    const raw = await getPageTextRaw(pid, "checkout", lang);
    text.completeButton = orderButtonLabel({
      hotelWording: raw.completeButton,
      fallback: text.completeButton,
      lang,
      eu: true,
    });
  }
  const totals = cartCoverage(lines);
  // The automatic offer (if any) is already baked into the line totals; derive
  // it for the itemised breakdown and each line's pre-discount price.
  const { offer, originalSubtotal, lines: linesView } = deriveOffer(lines);
  // A promo carried from the landing page (?promo=) is pre-applied here so the
  // guest sees the discount immediately.
  const urlPromo = await resolveAppliedPromo(pid, url.searchParams.get("promo") || "", totals.total);
  // Extras carried in the URL, re-priced from the catalog: per-room extras
  // against each room's guests, booking-scoped extras against the whole party.
  const party = stay.occ.adults + (stay.occ.childrenAge?.length ?? 0);
  const extraLines = resolveAllExtras(
    await getActiveExtras(pid),
    parseExtrasState(url.searchParams),
    extraContext(lines),
    nights,
    party,
  );
  // Effective payment + cancellation + no-show policy for the booking, plus the
  // cancellation snapshot (for the translated free-until line).
  const policy = await resolveBookingPolicy(pid, lines.map((l) => l.rateId));
  const cancellation = await resolveBookingCancellation(pid, lines.map((l) => l.rateId), stay.checkin);
  // A mixed cart (some refundable, some not) can't be described by one line, so
  // the UI shows a general "varies by room" note instead of the merged policy.
  const mixedCancellation = await cancellationVaries(pid, lines.map((l) => l.rateId));

  // Google Hotel price structured data — the final all-in total the guest sees,
  // so Google's price matches right through the last step (no surprise charges).
  const { grandTotal, adults, children } = stayTotals(
    lines,
    extraLines,
    { nights, checkin: stay.checkin, discount: urlPromo?.discount },
    taxConfigFrom(settings),
  );

  const trackedStay = {
    currency: stay.currency,
    checkin: stay.checkin,
    checkout: stay.checkout,
    nights,
    adults,
    children,
  };

  // Funnel step: checkout reached, with the money at stake — what the abandoned-
  // value dashboard number is made of. Non-fatal by design.
  const fc = await funnelContext(request);
  if (fc) {
    queueFunnelEvent({
      propertyId: pid,
      step: "checkout",
      visitKey: fc.visitKey,
      source: "web",
      checkin: stay.checkin,
      nights,
      adults,
      children,
      rooms: lines.length,
      value: grandTotal,
      currency: stay.currency,
      country: fc.country,
      lang,
      device: fc.device,
    });
  }

  // Whether a card is actually taken at checkout: only in LIVE mode, with a
  // payment gateway (Stripe or Viva) connected, when the rate charges now — or
  // wants a guarantee card, which only Stripe can hold. In test mode (or with
  // no gateway) nothing is collected, so the payment copy mustn't promise a
  // card — and the action likewise takes no payment (see below).
  const live =
    (settings.liveBooking ?? getConfig().allowLiveBooking) && settings.connectedSystem === "channex";
  const gateway = await activeGateway(pid, settings);
  const collectsCard =
    live &&
    Boolean(gateway) &&
    (dueNow(policy, grandTotal, nights) > 0 || (canSaveCard(gateway) && policy.payment.card === "guarantee"));
  const jsonLd = await reservationHotelJsonLd(
    pid,
    lang,
    { checkin: stay.checkin, checkout: stay.checkout },
    grandTotal,
  );

  return {
    stay,
    lines: linesView,
    nights,
    totals,
    originalSubtotal,
    offer,
    text,
    urlPromo,
    extraLines,
    policy,
    cancellation,
    mixedCancellation,
    // The cut-off time (and timezone) deadlines count back from. The component
    // re-derives the free-until moment client-side, and doing that with the
    // default anchor while the server used the property's would put two different
    // dates in front of the same guest.
    cancelAnchor: { time: settings.cancelAnchorTime, timezone: settings.timezone },
    termsUrl: settings.termsUrl,
    privacyUrl: settings.privacyUrl,
    // Only the rows the hotel marked as requiring acceptance — the rest are
    // footer links and have no business gating a booking.
    acceptLinks: (settings.legalLinks ?? []).filter((l) => l.accept),
    collectsCard,
    euConsumer,
    // The same grand total `purchase` will report, so checkout-to-purchase
    // drop-off compares like with like. The cart diff runs here too: this is
    // the last loader before the money, and a room added on the way in would
    // otherwise go unreported until the guest went back.
    tracking: isTagged(settings.analytics)
      ? {
          begin: beginCheckoutEvent(
            lines.map((l) => ({ roomId: l.roomId, roomTitle: l.roomTitle, rateTitle: l.rateTitle, total: l.total })),
            trackedStay,
            grandTotal,
          ),
          sel: url.searchParams.get("sel") ?? "",
          cart: cartTokenMap(lines),
          stay: trackedStay,
        }
      : null,
    taxConfig: taxConfigFrom(settings),
    jsonLd,
    // Set by the Viva return URL when a charge was refused and refunded; the
    // only value is a fixed token, never guest text.
    notice: url.searchParams.get("notice") === "refunded" ? ("refunded" as const) : undefined,
  };
}

// Messages are translation KEYS, not English. Zod runs in the action, which has
// no translator — and these reach the guest as field errors, so an English
// "Required" under a German label is a visible bug. Resolved at render below.
const GuestSchema = z.object({
  firstName: z.string().min(1, "fieldRequired"),
  lastName: z.string().min(1, "fieldRequired"),
  email: z.string().email("invalidEmail"),
  phone: z.string().min(3, "fieldRequired"),
  arrival: z.string().optional(),
  requests: z.string().optional(),
});

export async function action({ params, request }: Route.ActionArgs) {
  // Same preamble as the loader — one shared implementation, so the action
  // (the charge path, where the currency guard matters most) can never drift
  // from what the page showed.
  const { pid, base, url, checkin, checkout, occ, currency, nights, settings } =
    await requireDatedStay(params.channelId, request);
  const stay: Stay = { channelId: pid, checkin, checkout, currency, occ };

  const form = await request.formData();
  const intent = String(form.get("intent") || "book");
  const promoCode = String(form.get("promoCode") || "");

  const { rooms, lines } = await resolveStayCart(stay, url);
  if (!cartCovers(lines, stay.occ) || !withinAvailability(parseCart(url.searchParams), rooms)) {
    throw redirect(`${base}/rooms?${url.searchParams.toString()}`);
  }
  const totals = cartCoverage(lines);
  // The automatic offer is baked into the line totals; snapshot it, and the
  // value-adds, on the booking. Both come from this request's resolution of the
  // stay, so what's stored is what the guest was just shown.
  const { offer, valueAdds } = deriveOffer(lines);

  // "Apply" — preview the discount without booking, so typed guest details stay.
  if (intent === "applyPromo") {
    if (!normalizeCode(promoCode)) return { appliedPromo: null };
    const applied = await resolveAppliedPromo(stay.channelId, promoCode, totals.total);
    return applied ? { appliedPromo: applied } : { promoError: true, promoCode: normalizeCode(promoCode) };
  }

  // Gift-voucher preview — validate the code and return the spendable balance;
  // the UI shows how much of the due-now it covers. Re-validated at book time.
  if (intent === "applyVoucher") {
    const raw = String(form.get("voucherCode") || "").trim();
    if (!raw) return { appliedVoucher: null };
    const looked = await lookupVoucherGuarded(stay.channelId, raw, request).catch(() => null);
    const gv = looked === "limited" ? null : looked;
    const balance = gv && gv.kind === "gift" && displayStatus(gv) === "active" ? giftBalance(gv) : 0;
    return gv && balance > 0
      ? { appliedVoucher: { code: gv.code, balance } }
      : { voucherError: true as const, voucherCode: normalizeVoucherCode(raw) };
  }

  const parsed = GuestSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors };
  }

  // Re-resolve the promo server-side; a code entered but no longer valid must
  // not silently bill full price.
  const applied = await resolveAppliedPromo(stay.channelId, promoCode, totals.total);
  if (normalizeCode(promoCode) && !applied) {
    return { promoError: true, promoCode: normalizeCode(promoCode) };
  }
  const g = parsed.data;

  const config = getConfig();
  // Live vs test booking is controlled from admin General settings; an unsaved
  // setting falls back to the ALLOW_LIVE_BOOKING env var. (settings loaded above.)
  // Push to Channex only when the property has selected it as its connectivity;
  // otherwise simulate, even in live mode (there's nothing to push to).
  const live =
    (settings.liveBooking ?? config.allowLiveBooking) && settings.connectedSystem === "channex";

  // Extras re-priced server-side. VAT-applicable extras fold into the room's VAT
  // base; the rest are added on top untaxed.
  const party = stay.occ.adults + (stay.occ.childrenAge?.length ?? 0);
  const extraLines = resolveAllExtras(
    await getActiveExtras(stay.channelId),
    parseExtrasState(url.searchParams),
    extraContext(lines),
    nights,
    party,
  );
  // Full price the guest pays = discounted room + taxes/fees. The same
  // stayTotals the loader and component use, so what the guest saw is what
  // the booking charges.
  const { pricing, grandTotal, adults, children, discountedRoom: discountedTotal } = stayTotals(
    lines,
    extraLines,
    { nights, checkin: stay.checkin, discount: applied?.discount },
    taxConfigFrom(settings),
  );

  // Consent is required before we create the booking. A non-refundable or
  // charged-today rate needs the distinct acknowledgment too.
  const policy = await resolveBookingPolicy(stay.channelId, lines.map((l) => l.rateId));
  const due = dueNow(policy, grandTotal, nights);

  // Gift voucher: covers (part of) the amount due today. Re-resolved
  // server-side — a code that stopped being valid must not book unpaid.
  const voucherCodeInput = String(form.get("voucherCode") || "").trim();
  let voucherHold: { code: string; amount: number } | undefined;
  if (voucherCodeInput) {
    const looked = await lookupVoucherGuarded(stay.channelId, voucherCodeInput, request).catch(() => null);
    const gv = looked === "limited" ? null : looked;
    const balance = gv && gv.kind === "gift" && displayStatus(gv) === "active" ? giftBalance(gv) : 0;
    if (!gv || balance <= 0) {
      return { voucherError: true as const, voucherCode: normalizeVoucherCode(voucherCodeInput) };
    }
    // Pay-at-hotel rates collect nothing online — the voucher can't apply here
    // (v1 simplification; the guest presents it at the desk instead).
    if (due <= 0) return { voucherError: "payAtHotel" as const, voucherCode: gv.code };
    voucherHold = { code: gv.code, amount: Math.min(balance, Math.round(due * 100) / 100) };
  }
  const dueAfterVoucher = Math.round((due - (voucherHold?.amount ?? 0)) * 100) / 100;
  // Which gateway (Stripe / Viva) this property charges through, if any.
  const gateway = await activeGateway(stay.channelId, settings);
  // The same gate the form rendered its checkboxes from — see consentGate.
  const { needAck } = consentGate({
    policy,
    checkin: stay.checkin,
    anchor: { time: settings.cancelAnchorTime, timezone: settings.timezone },
    dueNow: dueAfterVoucher,
    collectsCard: live && Boolean(gateway) && (dueAfterVoucher > 0 || canSaveCard(gateway)),
  });
  const agreed = form.get("consent") === "on";
  const nonRefundableAck = form.get("ackNonRefundable") === "on";
  // Re-read the hotel's acceptance rows from settings rather than trusting the
  // form: a posted list of "policies I accepted" would let a caller decide for
  // itself which ones existed.
  const acceptLinks = (settings.legalLinks ?? []).filter((l) => l.accept);
  const ticked = new Set(form.getAll("acceptPolicy").map(String));
  const allAccepted = acceptLinks.every((l) => ticked.has(l.label));
  if (!agreed || (needAck && !nonRefundableAck) || !allAccepted) {
    return { consentError: true };
  }
  const desc = describePolicy(policy, settings.cancelAnchorTime);
  const consent = {
    acceptedAt: new Date().toISOString(),
    ip:
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      undefined,
    userAgent: request.headers.get("user-agent") || undefined,
    policyText: [desc.payment, desc.cancellation, desc.noShow].filter(Boolean),
    // What's actually charged today (after any gift voucher) — the finalize
    // tripwire compares this against the Stripe amount.
    dueNow: dueAfterVoucher,
    nonRefundableAck: needAck ? nonRefundableAck : undefined,
    // What they ticked, as it was worded to them — the label can be edited
    // later, and a consent record that changes afterwards defends nothing.
    acceptedPolicies: acceptLinks.length ? acceptLinks.map((l) => l.label) : undefined,
    marketingOptIn: form.get("marketing") === "on",
  };

  // Carry the cart params onto the post-payment confirmation page.
  const next = new URLSearchParams(url.searchParams);
  next.set("sim", live ? "0" : "1");
  if (applied?.code) next.set("promo", applied.code);

  // One book intent per stay+guest. The API takes Idempotency-Key; the hosted
  // form derives the same kind of key from the stay so a double-click reuses
  // one reference (and therefore one Stripe session / one uncarded finalize).
  const fingerprint = await hashCheckoutIntent(
    canonicalCheckoutIntent({
      pid: stay.channelId,
      checkin: stay.checkin,
      checkout: stay.checkout,
      currency: stay.currency,
      adults: stay.occ.adults,
      childrenAge: stay.occ.childrenAge ?? [],
      cart: serializeCart(parseCart(url.searchParams)),
      extras: serializeExtrasState(parseExtrasState(url.searchParams)),
      promo: applied?.code ?? "",
      voucher: voucherHold?.code ?? "",
      email: g.email,
      firstName: g.firstName,
      lastName: g.lastName,
      phone: g.phone,
    }),
  );
  const resolved = await resolveWebCheckoutIntent(
    stay.channelId,
    fingerprint,
    (ref) => `${base}/confirmation/${ref}?${next.toString()}`,
  );
  // A replay that lands on the confirmation page goes as a DOCUMENT navigation,
  // for the same reason as the first-time redirect below. A replay to a payment
  // URL is cross-origin and was always a document navigation anyway.
  if (resolved.kind === "redirect") throw (resolved.document ? redirectDocument : redirect)(resolved.url);
  const reference = resolved.reference;

  // Throttle new booking creation per client — not replays of a stay we
  // already accepted. The endpoint is anonymous, and every new booking
  // decrements availability and pushes to Channex.
  if (!(await rateLimit(`book:${pid}:${clientKey(request)}`, 10, 600))) {
    console.log(`[checkout] booking rate limit hit pid=${pid} client=${clientKey(request)}`);
    return { rateLimited: true as const };
  }

  // Build the booking (Open Channel payload + draft record), shared with the API.
  // Funnel context rides on the pending booking: finalize may run from the
  // Stripe webhook, where there is no guest request to derive it from.
  const funnelCtx: FunnelContext | null = await funnelContext(request);

  const pending = await preparePendingBooking({
    pid: stay.channelId,
    reference,
    funnel: funnelCtx ?? undefined,
    checkin: stay.checkin,
    checkout: stay.checkout,
    currency: stay.currency,
    nights,
    lines,
    pricing: { charges: pricing.charges, taxLines: pricing.taxLines, taxIncluded: pricing.taxIncluded },
    guest: {
      firstName: g.firstName,
      lastName: g.lastName,
      email: g.email,
      phone: g.phone,
      arrival: g.arrival || undefined,
      requests: g.requests || undefined,
    },
    grandTotal,
    baseTotal: totals.total,
    discountedTotal,
    applied: applied ?? undefined,
    offer: offer ?? undefined,
    valueAdds,
    extraLines,
    consent,
    // Written by the consent banner only once the guest allowed advertising,
    // so its mere presence is the permission — nothing to check again here.
    attribution: attributionFromCookies(request.headers.get("Cookie")),
    lang: langFromRequest(request),
    live,
    account: settings.stripeAccountId ?? "",
    origin: url.origin,
    returnParams: next.toString(),
    providerCode: config.providerCode,
    voucherPayment: voucherHold,
  });

  // A gateway is needed to charge a deposit/prepay (mode=payment) or — Stripe
  // only — to save a guarantee card for a pay-at-hotel rate that asks for one
  // (mode=setup). Every card policy wants a card — CardHandling is guarantee or
  // charge_at_booking, never "none". So when nothing is due today a Stripe
  // property still runs setup mode to put a card on file. Testing only for
  // "guarantee" meant a rate set to charge-at-booking with nothing due today
  // collected NOTHING, so its non-refundable and no-show terms were
  // unenforceable. Viva has no card-on-file mode: with nothing due today a Viva
  // property books directly, like a property with no gateway.
  // A due fully covered by the voucher needs no charge (and no guarantee card —
  // the stay is paid); the remainder, if any, goes through the gateway as usual.
  const stripeMode: "payment" | "setup" = dueAfterVoucher > 0 ? "payment" : "setup";

  // Only take a real payment in LIVE mode. In test mode the booking is
  // simulated and pushed nowhere, so charging would take money for a booking
  // that isn't created — skip the gateway entirely and fall through to the
  // simulated finalize below.
  // A paid rate with no way to charge must not book unpaid. A guarantee-only
  // rate without Stripe just books without a card (no-show cover is optional).
  if (live && dueAfterVoucher > 0 && !gateway) return { paymentError: "not_connected" as const };
  const goesToGateway = Boolean(live && gateway && (dueAfterVoucher > 0 || gateway.kind === "stripe"));

  // Reserve the voucher amount before any payment/booking side effects: a hold
  // that counts against the balance (so a shared code can't double-spend), with
  // a TTL matching the payment window. finalizeBooking settles or releases it.
  if (voucherHold) {
    const ttl = goesToGateway ? 3 * 3600 * 1000 : 15 * 60 * 1000;
    const held = await holdGiftAmount(stay.channelId, voucherHold.code, reference, voucherHold.amount, ttl);
    if (!held.ok) return { voucherError: true as const, voucherCode: voucherHold.code };
  }

  if (gateway && goesToGateway) {
    await stashPending(reference, pending);
    // The language the guest actually chose, as stored on the pending booking.
    // Optional there, so pin the fallback once rather than at three call sites.
    const guestLang = pending.record.lang || "en";
    // A human-readable summary of the stay for Stripe's hosted page — in the
    // guest's language, like the rest of their checkout. The action has no React
    // context, so the translator is built from the language stored on the pending
    // booking rather than from a hook.
    const tr = makeTranslator(guestLang);
    const fmtd = (d: Date, f: string) => format(d, f, { locale: tr.locale });
    const hotelName =
      (await getOverrides(stay.channelId, guestLang)).hotelName || tr.t("yourBookingFallback");
    const money = (n: number) => formatMoney(n, stay.currency);
    const ci = parseISO(stay.checkin);
    const co = parseISO(stay.checkout);
    const dateLabel = `${fmtd(ci, "EEE d MMM")} – ${fmtd(co, "EEE d MMM yyyy")}`;
    // Not occLabel(): that takes the children's ages, and by this point the lines
    // have been summed to plain counts. Same output, same plural keys.
    const guestLabel = tr.p("adult", adults) + (children ? `, ${tr.p("child", children)}` : "");
    const roomName =
      lines.length === 1
        ? `${lines[0].roomTitle} · ${lines[0].rateTitle}`
        : `${lines[0].roomTitle} + ${tr.p("moreRooms", lines.length - 1)}`;
    const balance = Math.round((grandTotal - due) * 100) / 100;
    const stayLine = `${dateLabel} · ${tr.p("night", nights)} · ${guestLabel}`;

    const voucherNote = voucherHold
      ? " " + tr.t("stripeVoucherNote", { amount: money(voucherHold.amount), code: voucherHold.code })
      : "";
    const balanceNote =
      (balance > 0 ? tr.t("stripeDepositNote", { balance: money(balance) }) : tr.t("stripePaidInFull")) + voucherNote;

    if (gateway.kind === "viva") {
      // Viva's hosted Smart Checkout: create a payment order and send the guest
      // to Viva's page. The success/failure URLs are configured statically on
      // the property's Viva payment source (/viva/return, /viva/failure), so
      // they can't carry the reference — the order-code mapping stashed here is
      // how the return leg (and the webhook) finds this checkout again.
      let payUrl: string;
      try {
        const orderCode = await createVivaOrder(gateway.viva, {
          amountMinor: toVivaMinor(dueAfterVoucher),
          customerTrns: `${hotelName} — ${roomName} · ${stayLine}. ${balanceNote}`,
          merchantTrns: reference,
          email: g.email,
          fullName: `${g.firstName} ${g.lastName}`,
          lang: guestLang,
        });
        await stashVivaOrder(orderCode, {
          ref: reference,
          pid: stay.channelId,
          channel: params.channelId ?? "",
        });
        payUrl = vivaCheckoutUrl(gateway.viva, orderCode);
      } catch (e) {
        // Viva is connected but rejected the order — log the real reason so
        // this isn't mistaken for "not set up".
        console.log(
          `[checkout] viva order failed for pid=${stay.channelId}: ${e instanceof Error ? e.message : e}`,
        );
        if (voucherHold) await releaseGiftHold(stay.channelId, voucherHold.code, reference);
        await releaseCheckoutIntent(stay.channelId, fingerprint);
        return { paymentError: "failed" as const };
      }
      await stashPending(reference, { ...pending, paymentUrl: payUrl });
      await writeWebCheckoutIdem(stay.channelId, fingerprint, { kind: "payment", reference, url: payUrl });
      throw redirect(payUrl);
    }

    if (gateway.kind === "iyzico") {
      // iyzico's hosted Checkout Form. Unlike Viva, the callback URL is given
      // per request, so it carries the reference itself and needs no order-code
      // mapping: the return leg reads ?ref= and finds the pending booking.
      let payUrl: string;
      try {
        const form = await initializeCheckoutForm(gateway.iyzico, {
          reference,
          amount: dueAfterVoucher,
          currency: stay.currency,
          callbackUrl: `${url.origin}${base}/iyzico/return?ref=${reference}`,
          lang: guestLang,
          buyer: {
            firstName: g.firstName,
            lastName: g.lastName,
            email: g.email,
            phone: g.phone,
            ip: request.headers.get("cf-connecting-ip") || undefined,
          },
          // One line, because iyzico requires the basket to sum to the amount
          // charged and `dueAfterVoucher` is a deposit or a voucher remainder
          // as often as it is the full stay — itemising rooms here would make
          // the two disagree on every booking that isn't paid in full.
          items: [{ id: reference, name: `${hotelName} — ${roomName}`, price: dueAfterVoucher }],
          identityNumber: IYZICO_PLACEHOLDER_IDENTITY,
        });
        payUrl = form.paymentPageUrl;
      } catch (e) {
        console.log(
          `[checkout] iyzico form failed for pid=${stay.channelId}: ${e instanceof Error ? e.message : e}`,
        );
        if (voucherHold) await releaseGiftHold(stay.channelId, voucherHold.code, reference);
        await releaseCheckoutIntent(stay.channelId, fingerprint);
        return { paymentError: "failed" as const };
      }
      await stashPending(reference, { ...pending, paymentUrl: payUrl });
      await writeWebCheckoutIdem(stay.channelId, fingerprint, { kind: "payment", reference, url: payUrl });
      throw redirect(payUrl);
    }

    const account = gateway.account;
    const sessionParams = buildCheckoutSessionParams({
      reference,
      email: g.email,
      metadata: { reference, pid: stay.channelId },
      // Stripe's own chrome — buttons, card labels, errors. Its default is "auto",
      // meaning the BROWSER's language, so a guest reading the site in German on
      // an English browser got an English payment page. Pass the language they
      // actually chose.
      locale: stripeLocale(guestLang),
      successUrl: `${url.origin}${base}/checkout/complete?session_id={CHECKOUT_SESSION_ID}&ref=${reference}&${next.toString()}`,
      cancelUrl: `${url.origin}${base}/checkout?${url.searchParams.toString()}`,
      currency: stay.currency,
      mode: stripeMode,
      amountMinor: toStripeMinor(dueAfterVoucher, stay.currency),
      paymentDescription: `${hotelName} · ${roomName} · ${dateLabel} (${tr.t("stripeRef", { ref: reference })})`,
      productName: `${hotelName} — ${roomName}`,
      productDescription: `${stayLine}. ${balanceNote}`,
      submitMessage:
        stripeMode === "payment"
          ? balance > 0
            ? tr.t("stripeSubmitDeposit", { due: money(dueAfterVoucher), hotel: hotelName, balance: money(balance) })
            : tr.t("stripeSubmitFull", { due: money(dueAfterVoucher), hotel: hotelName })
          : tr.t("stripeSubmitGuarantee", { hotel: hotelName, room: roomName, dates: dateLabel }),
    });
    let sessionUrl: string | undefined;
    try {
      const session = await createCheckoutSession(account, sessionParams, reference);
      sessionUrl = session.url;
    } catch (e) {
      // Stripe is connected but rejected the session — log the real reason
      // (acct/capability/amount/currency) so this isn't mistaken for "not set up".
      console.log(
        `[checkout] stripe session failed for pid=${stay.channelId} acct=${account}: ${e instanceof Error ? e.message : e}`,
      );
      if (voucherHold) await releaseGiftHold(stay.channelId, voucherHold.code, reference);
      await releaseCheckoutIntent(stay.channelId, fingerprint);
      return { paymentError: "failed" as const };
    }
    if (!sessionUrl) {
      if (voucherHold) await releaseGiftHold(stay.channelId, voucherHold.code, reference);
      await releaseCheckoutIntent(stay.channelId, fingerprint);
      return { paymentError: "failed" as const };
    }
    await stashPending(reference, { ...pending, paymentUrl: sessionUrl });
    await writeWebCheckoutIdem(stay.channelId, fingerprint, { kind: "payment", reference, url: sessionUrl });
    throw redirect(sessionUrl);
  }

  // No card needed (or a guarantee rate with Stripe not connected): book now.
  const record = await finalizeBooking(pending, undefined, url.origin);
  if (record.status === "failed") {
    await releaseCheckoutIntent(stay.channelId, fingerprint);
    return { bookingError: record.error };
  }
  // Also after the commit: a KV blip recording the idempotency marker costs a
  // duplicate-submit guard, not the guest's confirmation page.
  await afterCommit(reference, "checkout idempotency marker", () =>
    writeWebCheckoutIdem(stay.channelId, fingerprint, { kind: "confirmed", reference }),
  );
  // redirectDocument, NOT redirect: the booking is already created, pushed to
  // the PMS and emailed, so this navigation must not be able to fail.
  //
  // A plain redirect is followed CLIENT-side. React Router first has to
  // discover the confirmation route, which for a tab opened before the last
  // deploy means GET /__manifest?...&version=<stale> — and the server answers
  // that 204 with X-Remix-Reload-Document. React Router's own recovery for it
  // gives up silently once sessionStorage already holds that stale version
  // (fog-of-war.js), and the vite:preloadError handler in entry.client.tsx
  // can't stand in: a 204 from a fetch is not a module preload failure. The
  // route is never discovered, the navigation dies, and the guest gets the
  // root error boundary — with the booking made and the confirmation email in
  // their inbox. A Portuguese guest lost a seven-room Christmas booking to
  // exactly this on 2026-09-02; the Worker logged the action as a clean 202 and
  // never saw a request for the confirmation page at all.
  //
  // A document redirect is a plain GET against the current deployment: no
  // manifest lookup, no route discovery, no chunks from a build that is gone.
  return redirectDocument(`${base}/confirmation/${reference}?${next.toString()}`);
}

// Channex validates arrival_hour as strict HH:MM — offer a fixed list of times
// instead of free text, so what the guest picks is exactly what the PMS gets.
const ARRIVAL_TIMES = Array.from(
  { length: 48 },
  (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`,
);

function Field({
  name,
  label,
  type = "text",
  placeholder,
  error,
  autoComplete,
  inputMode,
}: {
  name: string;
  label: string;
  type?: string;
  placeholder?: string;
  error?: string[];
  /** Tells the browser and the phone's keychain what this field is, so guest
   *  details can be filled in one tap instead of typed on a phone keyboard. */
  autoComplete?: string;
  inputMode?: "text" | "tel" | "email" | "numeric";
}) {
  const s = useSlots();
  return (
    <label className="block text-caption font-semibold text-secondary">
      {label}
      <input
        name={name}
        type={type}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        className={cx("mt-[7px] block w-full", s.field, "px-3.5 py-[13px] text-body-lg text-ink outline-none focus:border-accent")}
      />
      {error?.[0] && (
        <span className="mt-1 block text-label font-normal text-danger">{error[0]}</span>
      )}
    </label>
  );
}

function Row({
  label,
  value,
  itemProp,
  content,
}: {
  label: string;
  value: string;
  /** Optional schema.org property for the VALUE cell (see the date rows). */
  itemProp?: string;
  /** Machine-readable form of a value shown in a human one. */
  content?: string;
}) {
  return (
    <div className="flex justify-between">
      <span className="text-secondary">{label}</span>
      <span className="font-semibold" itemProp={itemProp} content={content}>
        {value}
      </span>
    </div>
  );
}

export function meta({ matches }: Route.MetaArgs) {
  return pageMeta(matches, { titleKey: "metaCheckout", noindex: true });
}

/** Terms / privacy reference: a link when the hotel has set a URL, otherwise
 *  plain emphasis — the sentence has to read either way, since these documents
 *  are named whether or not a URL exists. */
function LegalRef({ url, label }: { url?: string | null; label: string }) {
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="font-semibold text-accent underline"
    >
      {label}
    </a>
  ) : (
    <span className="font-semibold">{label}</span>
  );
}


export default function Checkout({ loaderData, actionData, params }: Route.ComponentProps) {
  const base = useBase();
  const home = useHome();
  const { stay, lines, nights, totals, text, offer, originalSubtotal, extraLines, policy, cancellation, mixedCancellation, cancelAnchor, termsUrl, privacyUrl, acceptLinks, jsonLd, collectsCard, euConsumer, tracking, notice } = loaderData;
  const { currency, hotelName } = useProperty();
  const tr = useT();
  const s = useSlots();
  const fmt = (d: Date, f: string) => format(d, f, { locale: tr.locale });
  const [searchParams] = useSearchParams();
  const nav = useNavigation();
  const errors = actionData?.errors;
  const bookingError = actionData?.bookingError;
  const promoError = actionData?.promoError ?? false;
  // Prefer the result of an Apply/Book round-trip; otherwise use the promo
  // pre-applied from the URL (?promo carried from the landing page).
  const actionHasPromo = !!actionData && "appliedPromo" in actionData;
  const appliedPromo = actionHasPromo
    ? (actionData?.appliedPromo ?? undefined)
    : promoError
      ? undefined
      : (loaderData.urlPromo ?? undefined);
  const promoCodeValue = actionData?.promoCode ?? appliedPromo?.code ?? "";
  const voucherError = actionData && "voucherError" in actionData ? actionData.voucherError : false;
  const appliedVoucher =
    actionData && "appliedVoucher" in actionData ? (actionData.appliedVoucher ?? undefined) : undefined;
  const voucherCodeValue =
    (actionData && "voucherCode" in actionData ? actionData.voucherCode : undefined) ?? appliedVoucher?.code ?? "";
  const submitting = nav.state === "submitting";

  const discount = appliedPromo?.discount ?? 0;
  // The same stayTotals the loader and action use — the number on the button
  // is the number the action charges.
  const { pricing, grandTotal } = stayTotals(
    lines,
    extraLines,
    { nights, checkin: stay.checkin, discount },
    loaderData.taxConfig,
  );

  // ---- payment + policy summary (display only; no real charging) ----
  const due = dueNow(policy, grandTotal, nights);
  const atHotel = Math.round((grandTotal - due) * 100) / 100;
  // Gift voucher preview: how much of the due-now the applied voucher covers.
  const voucherApplied = appliedVoucher && due > 0 ? Math.min(appliedVoucher.balance, due) : 0;
  const dueShown = Math.round((due - voucherApplied) * 100) / 100;
  const cardCharged = policy.payment.card === "charge_at_booking" || policy.payment.timing === "full_prepay";
  const penaltyPhrase = (penalty: string, value?: number) => {
    switch (penalty) {
      case "first_night":
        return tr.t("penaltyFirstNight");
      case "full_stay":
        return tr.t("penaltyFullStay");
      case "percent":
        return value ? tr.t("penaltyPercent", { n: value }) : "";
      case "fixed":
        return value ? formatMoney(value, currency) : "";
      default:
        return "";
    }
  };
  // Cancellation + consent, from the same gate the action rejects on.
  // atBooking → a free window that's already closed reads as non-refundable, not a past date.
  const { cancelInfo, freeWindowClosed, nonRefundable, chargedToday, needAck } = consentGate({
    policy,
    checkin: stay.checkin,
    anchor: cancelAnchor,
    dueNow: dueShown,
    collectsCard,
  });
  const cancelMsg = cancellationMessage(cancelInfo, Date.now(), { atBooking: true });
  const cancellationText =
    policy.overrideNote ||
    (cancelMsg
      ? tr.t(
          cancelMsg.key,
          "iso" in cancelMsg ? { date: formatCancelDeadline(cancelMsg, "EEE d MMM yyyy", tr.locale) } : undefined,
        )
      : "");
  // The cancellation + withdrawal group above the order button. It carries the
  // rule that separates the summary from the consent ticks, so the ticks only
  // draw their own when the group isn't there.
  const cancellationOnPage = mixedCancellation || Boolean(cancellationText);
  const legalAbove = cancellationOnPage || euConsumer;
  const consentTop = legalAbove ? "pt-3.5" : cx("border-t", s.rule, "pt-4");
  const tier0 = policy.cancellation.tiers[0];
  // The "after the deadline …" line only makes sense while the deadline is still
  // ahead — once it's passed the lead line already reads "non-refundable".
  const latePhrase =
    policy.cancellation.refundable && !freeWindowClosed && tier0 && tier0.penalty !== "none" && !policy.overrideNote
      ? penaltyPhrase(tier0.penalty, tier0.penaltyValue)
      : "";
  // Silenced by an override note for the same reason as latePhrase above: the
  // hotel's own text already states what happens, and ours contradicted it.
  const noShowPhrase =
    policy.noShow.penalty !== "none" && !policy.overrideNote
      ? penaltyPhrase(policy.noShow.penalty, policy.noShow.penaltyValue)
      : "";

  // ---- consent ----
  const ackText = nonRefundable
    ? chargedToday
      ? tr.t("ackNonRefundableCharged", { amount: formatMoney(dueShown, currency) })
      : tr.t("ackNonRefundable")
    : tr.t("ackCharged", { amount: formatMoney(dueShown, currency) });
  const [agree, setAgree] = useState(false);
  const [accepted, setAccepted] = useState<string[]>([]);
  const [ack, setAck] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [consentError, setConsentError] = useState(false);
  const showConsentError = consentError || (!!actionData && "consentError" in actionData && actionData.consentError === true);
  const checkboxCls = "mt-0.5 h-4 w-4 flex-none rounded border-line-alt text-accent focus:ring-accent";

  const childCount = stay.occ.childrenAge?.length ?? 0;

  return (
    // The last page a guest reaches before payment, so this is where Google's
    // price-accuracy crawler stops and reads the total. The whole page is the
    // co-typed Hotel + LodgingReservation scope Google requires, because the
    // properties it holds are spread across it: the hotel in the summary aside,
    // the total further down inside PriceBreakdown.
    <main
      className="mx-auto max-w-[1160px] px-7 pb-[72px] pt-9"
      {...hotelReservationScope}
      {...navStage("checkout", true)}
    >
      {/* Identity and occupancy as <meta>: these are matching keys, not prices.
          The identifier is the same property id the Hotel List Feed publishes,
          which is what Google joins on. Only the PRICE has to be visible, and
          it is (see PriceBreakdown). */}
      <meta itemProp="identifier" content={stay.channelId} />
      <meta itemProp="numAdults" content={String(stay.occ.adults)} />
      <meta itemProp="numChildren" content={String(childCount)} />
      {jsonLd && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(jsonLd) }} />
      )}
      {tracking && (
        <>
          {/* Signed by the cart, so editing the stay and coming back reports a
              second begin_checkout — which is what happened. */}
          <TrackFunnel event={tracking.begin} signature={`checkout:${tracking.sel}`} />
          <TrackCart sel={tracking.sel} lines={tracking.cart} stay={tracking.stay} />
        </>
      )}
      <Link
        to={`${base}/rooms?${searchParams.toString()}`}
        className="mb-[18px] inline-block text-sm font-semibold text-muted hover:text-accent"
      >
        ← {tr.t("allRooms")}
      </Link>
      <h1 className="mb-7 font-serif text-display-lg font-medium tracking-[-0.02em]">{text.heading}</h1>

      {bookingError && (
        <div className="mb-6 rounded-card border border-danger-line bg-danger-soft px-4 py-3 text-body text-danger">
          {bookingError}
        </div>
      )}

      {actionData?.rateLimited && (
        <div className="mb-6 rounded-card border border-notice-line bg-notice-soft px-4 py-3 text-body text-notice">
          {tr.t("bookingThrottled")}
        </div>
      )}

      {notice === "refunded" && (
        <div className="mb-6 rounded-card border border-notice-line bg-notice-soft px-4 py-3 text-body text-notice">
          {tr.t("paymentRefundedNotice")}
        </div>
      )}

      {actionData?.paymentError && (
        <div className="mb-6 rounded-card border border-danger-line bg-danger-soft px-4 py-3 text-body text-danger">
          {actionData.paymentError === "failed"
            ? tr.t("paymentStartFailed")
            : tr.t("paymentNotConfigured")}
        </div>
      )}

      <Form method="post" className="flex flex-wrap items-start gap-9">
        <div className="flex min-w-[340px] flex-[1.5] flex-col gap-7">
          <section className={cx(s.panel, "p-[26px]")}>
            <h3 className="mb-[18px] font-serif text-title-md font-semibold">{text.guestSection}</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field name="firstName" label={tr.t("firstName")} placeholder="Jamie" autoComplete="given-name" error={errors?.firstName?.map((k) => tr.t(k))} />
              <Field name="lastName" label={tr.t("lastName")} placeholder="Doyle" autoComplete="family-name" error={errors?.lastName?.map((k) => tr.t(k))} />
              <Field name="email" label={tr.t("email")} type="email" autoComplete="email" inputMode="email" placeholder="jamie@email.com" error={errors?.email?.map((k) => tr.t(k))} />
              {/* type=tel, not text: it's what brings up the phone keypad. The
                  value stays a free-text string — numbers are typed with spaces,
                  dashes and country prefixes and the server parses it as text. */}
              <Field name="phone" label={tr.t("phone")} type="tel" autoComplete="tel" inputMode="tel" placeholder="+44 …" error={errors?.phone?.map((k) => tr.t(k))} />
            </div>
          </section>

          <section className={cx(s.panel, "p-[26px]")}>
            <h3 className="mb-[18px] font-serif text-title-md font-semibold">{text.arrivalSection}</h3>
            <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="block text-caption font-semibold text-secondary">
                {tr.t("estimatedArrival")}
                <select
                  name="arrival"
                  defaultValue=""
                  className={cx("mt-[7px] block w-full", s.field, "px-3.5 py-[13px] text-body-lg text-ink outline-none focus:border-accent")}
                >
                  <option value="">{tr.t("arrivalUnknown")}</option>
                  {ARRIVAL_TIMES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block text-caption font-semibold text-secondary">
              {tr.t("specialRequests")}
              <textarea
                name="requests"
                rows={3}
                placeholder={text.requestsPlaceholder}
                className={cx("mt-[7px] block w-full resize-y", s.field, "px-3.5 py-[13px] text-body-lg text-ink outline-none focus:border-accent")}
              />
            </label>
          </section>

          <section className={cx(s.panel, "p-[26px]")}>
            <h3 className="mb-3 font-serif text-title-md font-semibold">{text.paymentSection}</h3>

            {/* The due-now/at-hotel split only makes sense when a card is really
                collected at checkout. Without payments set up nothing is charged
                today — showing a policy-derived "Due now" would contradict the
                note below. */}
            {collectsCard && (
              <div className="mb-3 flex flex-col gap-1.5 text-body">
                {voucherApplied > 0 && appliedVoucher && (
                  <div className="flex justify-between text-success">
                    <span>
                      {tr.t("voucherAppliedLabel")} ({appliedVoucher.code})
                    </span>
                    <span className="font-semibold">−{formatMoney(voucherApplied, currency)}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-secondary">{tr.t("dueNow")}</span>
                  <span className="font-semibold">{formatMoney(dueShown, currency)}</span>
                </div>
                {atHotel > 0 && (
                  <div className="flex justify-between">
                    <span className="text-secondary">{tr.t("dueAtHotel")}</span>
                    <span className="font-semibold">{formatMoney(atHotel, currency)}</span>
                  </div>
                )}
              </div>
            )}
            {/* `collectsCard` is false for two unrelated reasons: the policy has
                nothing due now, OR this property simply isn't set up to take
                payment (not live, no Stripe). Only the first justifies telling a
                guest they'll settle up at the hotel — in the second the policy may
                well be full prepayment, and promising otherwise is a claim we
                can't stand behind. So the copy follows the POLICY, not our own
                configuration state. */}
            <p className="mb-[18px] text-sm leading-[1.55] text-muted">
              {collectsCard
                ? cardCharged
                  ? tr.t("cardChargedNote")
                  : tr.t("cardGuaranteeNote")
                : policy.payment.timing === "pay_at_hotel"
                  ? tr.t("payAtHotelNote")
                  : tr.t("payArrangedNote")}
            </p>

            {mixedCancellation ? (
              <div className={cx("mb-[18px] border-t", s.rule, "pt-3.5 text-caption text-secondary")}>
                {tr.t("cancellationVariesByRoom")}
              </div>
            ) : (
              (cancellationText || latePhrase || noShowPhrase) && (
                <div className={cx("mb-[18px] flex flex-col gap-1.5 border-t", s.rule, "pt-3.5 text-caption text-secondary")}>
                  {cancellationText && <div>{cancellationText}</div>}
                  {latePhrase && <div className="text-muted-2">{tr.t("afterDeadlineCharge", { penalty: latePhrase })}</div>}
                  {noShowPhrase && <div className="text-muted-2">{tr.t("noShowCharge", { penalty: noShowPhrase })}</div>}
                </div>
              )
            )}
          </section>
        </div>

        {/* summary */}
        <aside
          className={cx("sticky top-24 min-w-[300px] flex-1", s.strip, "p-6")}
          style={{ boxShadow: "var(--shadow-sticky)" }}
        >
          {/* The hotel being booked, named on the page rather than only in the
              header. Google wants `name` as visible text inside the reservation
              scope, and the header sits outside <main>; a checkout summary that
              says which hotel this is was worth having anyway. */}
          <div itemProp="name" className="mb-1 text-label font-semibold uppercase tracking-wide text-muted-2">
            {hotelName}
          </div>
          <h3 className="mb-4 font-serif text-title-md font-semibold">
            {tr.p("yourStayRooms", lines.length)}
          </h3>
          <div className={cx("flex flex-col gap-3 border-b", s.rule, "pb-4")}>
            {lines.map((l, i) => (
              <div key={`${l.roomId}-${i}`} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-body font-semibold">{l.roomTitle}</div>
                  <div className="text-label text-muted-2">{l.rateTitle}</div>
                </div>
                <span className="whitespace-nowrap text-body font-semibold">
                  {formatMoney(l.originalTotal, currency)}
                </span>
              </div>
            ))}
          </div>
          <div className={cx("flex flex-col gap-2.5 border-b", s.rule, "py-4 text-body")}>
            {/* Displayed in the guest's language and format; tagged with the
                ISO date in `content`, which is how Google's guide says to
                standardise a visible date.
                checkinTime/checkoutTime, NOT checkinDate/checkoutDate: Google
                lists the latter as "also acceptable", but no such property
                exists on schema.org and validator.schema.org rejects it on a
                Hotel — verified against the live page, 2026-09-05. These are
                also the names the JSON-LD offer already uses. */}
            <Row
              label={tr.t("checkIn")}
              value={fmt(parseISO(stay.checkin), "EEE d MMM")}
              itemProp="checkinTime"
              content={stay.checkin}
            />
            <Row
              label={tr.t("checkOut")}
              value={fmt(parseISO(stay.checkout), "EEE d MMM")}
              itemProp="checkoutTime"
              content={stay.checkout}
            />
            <Row label={tr.t("nights")} value={String(nights)} />
            <Row label={tr.t("guests")} value={occLabel(tr, stay.occ.adults, stay.occ.childrenAge)} />
          </div>
          {(offer || (discount > 0 && appliedPromo)) && (
            <div className={cx("flex flex-col gap-2.5 border-b", s.rule, "py-4 text-body")}>
              <Row label={tr.t("subtotal")} value={formatMoney(originalSubtotal, currency)} />
              {offer && offer.discount > 0 && (
                <div className="flex justify-between text-success">
                  <span>
                    {offer.name} (−{offer.value}%)
                  </span>
                  <span className="font-semibold">−{formatMoney(offer.discount, currency)}</span>
                </div>
              )}
              {discount > 0 && appliedPromo && (
                <div className="flex justify-between text-success">
                  <span>
                    {tr.t("discount")} ({appliedPromo.code})
                  </span>
                  <span className="font-semibold">−{formatMoney(discount, currency)}</span>
                </div>
              )}
            </div>
          )}

          {/* promo code */}
          <div className={cx("border-b", s.rule, "py-4")}>
            {/* htmlFor/id, not nesting: the input sits in a flex row with its
                Apply button, so it can't be a child of the label. Without the
                pairing the field was announced with no name at all. */}
            <label
              htmlFor="promoCode"
              className="block text-label font-semibold uppercase tracking-wide text-muted-2"
            >
              {tr.t("promoCode")}
            </label>
            <div className="mt-2 flex gap-2">
              <input
                id="promoCode"
                name="promoCode"
                defaultValue={promoCodeValue}
                placeholder="SUMMER10"
                autoComplete="off"
                className={cx("min-w-0 flex-1", s.field, "px-3 py-2.5 text-body uppercase text-ink outline-none focus:border-accent")}
              />
              <button
                type="submit"
                name="intent"
                value="applyPromo"
                formNoValidate
                disabled={submitting}
                className={cx("flex-none rounded-control border border-line-alt bg-surface px-4 py-2.5 text-caption font-semibold text-ink hover:border-accent hover:text-accent disabled:opacity-60")}
              >
                {tr.t("applyCode")}
              </button>
            </div>
            {promoError && <p className="mt-1.5 text-label text-danger">{tr.t("promoInvalid")}</p>}
            {appliedPromo && discount > 0 && (
              <p className="mt-1.5 text-label text-success">{tr.t("promoApplied")}</p>
            )}
          </div>

          {/* gift voucher — pays (part of) the amount due today */}
          <div className={cx("border-b", s.rule, "py-4")}>
            <label
              htmlFor="voucherCode"
              className="block text-label font-semibold uppercase tracking-wide text-muted-2"
            >
              {tr.t("voucherHave")}
            </label>
            <div className="mt-2 flex gap-2">
              <input
                id="voucherCode"
                name="voucherCode"
                defaultValue={voucherCodeValue}
                placeholder="RP-XXXX-XXXX"
                autoComplete="off"
                className={cx("min-w-0 flex-1", s.field, "px-3 py-2.5 text-body uppercase text-ink outline-none focus:border-accent")}
              />
              <button
                type="submit"
                name="intent"
                value="applyVoucher"
                formNoValidate
                disabled={submitting}
                className={cx("flex-none rounded-control border border-line-alt bg-surface px-4 py-2.5 text-caption font-semibold text-ink hover:border-accent hover:text-accent disabled:opacity-60")}
              >
                {tr.t("applyCode")}
              </button>
            </div>
            {voucherError === true && <p className="mt-1.5 text-label text-danger">{tr.t("voucherInvalid")}</p>}
            {voucherError === "payAtHotel" && (
              <p className="mt-1.5 text-label text-notice">{tr.t("voucherPayAtHotel")}</p>
            )}
            {appliedVoucher && voucherApplied > 0 && (
              <p className="mt-1.5 text-label text-success">
                {tr.t("voucherAppliedNote", { amount: formatMoney(voucherApplied, currency) })}
              </p>
            )}
          </div>

          <PriceBreakdown
            pricing={pricing}
            extraLines={extraLines}
            grandTotal={grandTotal}
            currency={currency}
            variant="checkout"
            offerMicrodata
          />

          {/* § 312j(2) BGB / Art. 8(2) CRD: what the guest is agreeing to has to
              be in front of them where they click — not further up the page and
              not underneath the button, which is where the cancellation line
              used to sit. The stay, the dates, the guests and the total are the
              rows immediately above this; the withdrawal notice is EU/EEA only
              and resolved from the property's country. */}
          {legalAbove && (
            <div className={cx("mt-4 border-t", s.rule, "pt-3.5 text-caption leading-[1.5] text-secondary")}>
              {mixedCancellation
                ? tr.t("cancellationVariesByRoom")
                : cancellationText && <div>{cancellationText}</div>}
              {euConsumer && (
                <p className={cx(cancellationOnPage && "mt-2", "text-label text-muted-2")}>
                  {tr.t("noWithdrawalRight")}
                </p>
              )}
            </div>
          )}

          {/* consent — required ticks sit directly above the booking button */}
          <div className={cx("mb-3 flex flex-col gap-2.5", consentTop)}>
            <label className="flex items-start gap-2.5 text-caption leading-[1.5] text-secondary">
              <input
                type="checkbox"
                name="consent"
                checked={agree}
                onChange={(e) => { setAgree(e.target.checked); setConsentError(false); }}
                className={checkboxCls}
              />
              {/* One translatable sentence with the two links as placeholders —
                  the previous version concatenated English fragments in JSX,
                  which can't be translated (word order moves, and in German the
                  verb goes last). */}
              <span>
                <Trans
                  tr={tr}
                  k="consentAgree"
                  parts={{
                    terms: <LegalRef url={termsUrl} label={tr.t("termsLink")} />,
                    privacy: <LegalRef url={privacyUrl} label={tr.t("privacyLink")} />,
                  }}
                />
              </span>
            </label>

            {acceptLinks.map((l) => (
              <label key={l.label} className="flex items-start gap-2.5 text-caption leading-[1.5] text-secondary">
                <input
                  type="checkbox"
                  name="acceptPolicy"
                  value={l.label}
                  checked={accepted.includes(l.label)}
                  onChange={(e) => {
                    setAccepted((prev) => (e.target.checked ? [...prev, l.label] : prev.filter((x) => x !== l.label)));
                    setConsentError(false);
                  }}
                  className={checkboxCls}
                />
                {/* The hotel's own wording, unchanged — see LegalLink. Only the
                    sentence around it is translated. */}
                <span>
                  <Trans tr={tr} k="acceptPolicy" parts={{ policy: <LegalRef url={l.url} label={l.label} /> }} />
                </span>
              </label>
            ))}

            {needAck && (
              <label className="flex items-start gap-2.5 text-caption leading-[1.5] text-secondary">
                <input
                  type="checkbox"
                  name="ackNonRefundable"
                  checked={ack}
                  onChange={(e) => { setAck(e.target.checked); setConsentError(false); }}
                  className={checkboxCls}
                />
                <span className="font-medium">{ackText}</span>
              </label>
            )}

            <label className="flex items-start gap-2.5 text-caption leading-[1.5] text-muted">
              <input
                type="checkbox"
                name="marketing"
                checked={marketing}
                onChange={(e) => setMarketing(e.target.checked)}
                className={checkboxCls}
              />
              <span>
                {hotelName
                  ? tr.t("marketingOptInFrom", { hotel: hotelName })
                  : tr.t("marketingOptIn")}
              </span>
            </label>

            {showConsentError && (
              <p className="text-label font-medium text-danger">
                {tr.t("consentRequired")}
              </p>
            )}
          </div>

          <button
            type="submit"
            name="intent"
            value="book"
            disabled={submitting}
            onClick={(e) => {
              if (!agree || (needAck && !ack) || acceptLinks.some((l) => !accepted.includes(l.label))) {
                e.preventDefault();
                setConsentError(true);
              }
            }}
            className={cx("w-full", s.btnPrimary, "py-[15px] text-lead font-semibold transition-colors disabled:opacity-60")}
          >
            {submitting ? tr.t("confirming") : text.completeButton}
          </button>
          {collectsCard && (
            <div className="mt-2.5 flex items-center justify-center gap-1.5 text-label text-muted-2">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <rect x="4" y="10" width="16" height="11" rx="2.5" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3" />
              </svg>
              {tr.t("walletsAccepted")}
            </div>
          )}
        </aside>
      </Form>
    </main>
  );
}
