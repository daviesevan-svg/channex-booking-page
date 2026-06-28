import { addDays, differenceInCalendarDays, format, parseISO } from "date-fns";
import { useState } from "react";
import { Form, Link, redirect, useNavigation, useSearchParams } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/checkout";
import type { RoomWithRates } from "~/lib/channex/types";
import { useProperty } from "~/lib/booking-context";
import {
  cartCoverage,
  cartCovers,
  parseCart,
  withinAvailability,
  type ResolvedLine,
} from "~/lib/cart";
import {
  generateReference,
  recordBooking,
  stayAvailabilityItems,
  type BookingStatus,
} from "~/lib/bookings.server";
import { resolveBookingCancellation, resolveBookingPolicy } from "~/lib/policy.server";
import { dueNow, policyToCancellation } from "~/lib/policy-copy";
import { describePolicy } from "~/lib/rate-policy";
import { cancellationMessage } from "~/lib/cancellation";
import { resolveAppliedPromo } from "~/lib/promotions.server";
import { normalizeCode, type AppliedPromo } from "~/lib/promotions";
import { getActiveExtras } from "~/lib/extras.server";
import { groupExtrasByRoom, parseExtrasState, resolveAllExtras, taxableExtrasTotal, untaxedExtrasTotal, type ExtraContextLine } from "~/lib/extras";
import { getConfig } from "~/lib/config.server";
import { getSettings } from "~/lib/overrides.server";
import { computePricing, taxConfigFrom } from "~/lib/pricing";
import { pushOpenChannelBooking } from "~/lib/open-channel.server";
import { formatMoney } from "~/lib/money";
import { readOccupancy, type Occupancy } from "~/lib/occupancy";
import { occLabel, useT } from "~/lib/i18n";
import { langFromRequest } from "~/lib/content";
import { getPageText } from "~/lib/overrides.server";
import { getCatalogRooms, resolveCartByOccupancy } from "~/lib/catalog.server";
import { decrementAvailability } from "~/lib/ari.server";

interface Stay {
  channelId: string;
  checkin: string;
  checkout: string;
  currency: string;
  occ: Occupancy;
}

function readStay(url: URL, channelId: string): Stay | null {
  const checkin = url.searchParams.get("checkin");
  const checkout = url.searchParams.get("checkout");
  if (!checkin || !checkout) return null;
  return {
    channelId,
    checkin,
    checkout,
    currency: url.searchParams.get("currency") || "GBP",
    occ: readOccupancy(url.searchParams),
  };
}

async function resolveStayCart(
  stay: Stay,
  url: URL,
): Promise<{ rooms: RoomWithRates[]; lines: ResolvedLine[] }> {
  const rooms = await getCatalogRooms(
    stay.channelId,
    {
      checkinDate: stay.checkin,
      checkoutDate: stay.checkout,
      currency: stay.currency,
      adults: stay.occ.adults,
      childrenAge: stay.occ.childrenAge,
    },
    { gate: true },
  );
  const lines = await resolveCartByOccupancy(
    stay.channelId,
    { checkin: stay.checkin, checkout: stay.checkout, currency: stay.currency },
    parseCart(url.searchParams),
    { adults: stay.occ.adults, childrenAge: stay.occ.childrenAge },
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
  return { offer, originalSubtotal, lines: view };
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const stay = readStay(url, params.channelId);
  if (!stay) throw redirect(`/${params.channelId}`);

  const lang = langFromRequest(request);
  const { rooms, lines } = await resolveStayCart(stay, url);
  if (!cartCovers(lines, stay.occ) || !withinAvailability(parseCart(url.searchParams), rooms)) {
    throw redirect(`/${params.channelId}/rooms?${url.searchParams.toString()}`);
  }

  const nights = Math.max(1, differenceInCalendarDays(parseISO(stay.checkout), parseISO(stay.checkin)));
  const text = await getPageText(params.channelId, "checkout", lang);
  const totals = cartCoverage(lines);
  const settings = await getSettings(params.channelId);
  // The automatic offer (if any) is already baked into the line totals; derive
  // it for the itemised breakdown and each line's pre-discount price.
  const { offer, originalSubtotal, lines: linesView } = deriveOffer(lines);
  // A promo carried from the landing page (?promo=) is pre-applied here so the
  // guest sees the discount immediately.
  const urlPromo = await resolveAppliedPromo(params.channelId, url.searchParams.get("promo") || "", totals.total);
  // Extras carried in the URL, re-priced from the catalog: per-room extras
  // against each room's guests, booking-scoped extras against the whole party.
  const party = stay.occ.adults + (stay.occ.childrenAge?.length ?? 0);
  const extraLines = resolveAllExtras(
    await getActiveExtras(params.channelId),
    parseExtrasState(url.searchParams),
    extraContext(lines),
    nights,
    party,
  );
  // Effective payment + cancellation + no-show policy for the booking, plus the
  // cancellation snapshot (for the translated free-until line).
  const policy = await resolveBookingPolicy(params.channelId, lines.map((l) => l.rateId));
  const cancellation = await resolveBookingCancellation(params.channelId, lines.map((l) => l.rateId), stay.checkin);
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
    termsUrl: settings.termsUrl,
    privacyUrl: settings.privacyUrl,
    taxConfig: taxConfigFrom(settings),
  };
}

const GuestSchema = z.object({
  firstName: z.string().min(1, "Required"),
  lastName: z.string().min(1, "Required"),
  email: z.string().email("Enter a valid email"),
  phone: z.string().min(3, "Required"),
  arrival: z.string().optional(),
  requests: z.string().optional(),
});

export async function action({ params, request }: Route.ActionArgs) {
  const url = new URL(request.url);
  const stay = readStay(url, params.channelId);
  if (!stay) throw redirect(`/${params.channelId}`);

  const form = await request.formData();
  const intent = String(form.get("intent") || "book");
  const promoCode = String(form.get("promoCode") || "");

  const { rooms, lines } = await resolveStayCart(stay, url);
  if (!cartCovers(lines, stay.occ) || !withinAvailability(parseCart(url.searchParams), rooms)) {
    throw redirect(`/${params.channelId}/rooms?${url.searchParams.toString()}`);
  }
  const totals = cartCoverage(lines);
  // The automatic offer is baked into the line totals; snapshot it on the booking.
  const { offer } = deriveOffer(lines);

  // "Apply" — preview the discount without booking, so typed guest details stay.
  if (intent === "applyPromo") {
    if (!normalizeCode(promoCode)) return { appliedPromo: null };
    const applied = await resolveAppliedPromo(stay.channelId, promoCode, totals.total);
    return applied ? { appliedPromo: applied } : { promoError: true, promoCode: normalizeCode(promoCode) };
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
  const discount = applied?.discount ?? 0;
  const discountedTotal = Math.round((totals.total - discount) * 100) / 100;

  const g = parsed.data;
  const config = getConfig();
  // Live vs test booking is controlled from admin General settings; an unsaved
  // setting falls back to the ALLOW_LIVE_BOOKING env var.
  const settings = await getSettings(stay.channelId);
  const live = settings.liveBooking ?? config.allowLiveBooking;
  const nights = Math.max(1, differenceInCalendarDays(parseISO(stay.checkout), parseISO(stay.checkin)));
  // Random, unguessable reference — also the guest's manage-booking credential.
  const reference = generateReference();

  // Full price the guest pays = discounted room + taxes/fees.
  const adults = lines.reduce((s, l) => s + l.occupancy.adults, 0);
  const children = lines.reduce((s, l) => s + l.occupancy.children, 0);
  const cleaningFee = lines.reduce((s, l) => s + l.cleaningFee, 0);
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
  const pricing = computePricing(
    {
      base: discountedTotal,
      nights,
      adults,
      children,
      rooms: lines.length,
      cleaningFee,
      taxableExtras: taxableExtrasTotal(extraLines),
    },
    taxConfigFrom(settings),
  );
  const grandTotal = Math.round((pricing.total + untaxedExtrasTotal(extraLines)) * 100) / 100;

  // Consent is required before we create the booking. A non-refundable or
  // charged-today rate needs the distinct acknowledgment too.
  const policy = await resolveBookingPolicy(stay.channelId, lines.map((l) => l.rateId));
  const due = dueNow(policy, grandTotal, nights);
  const needAck = !policy.cancellation.refundable || due > 0;
  const agreed = form.get("consent") === "on";
  const nonRefundableAck = form.get("ackNonRefundable") === "on";
  if (!agreed || (needAck && !nonRefundableAck)) {
    return { consentError: true };
  }
  const desc = describePolicy(policy);
  const consent = {
    acceptedAt: new Date().toISOString(),
    ip:
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      undefined,
    userAgent: request.headers.get("user-agent") || undefined,
    policyText: [desc.payment, desc.cancellation, desc.noShow].filter(Boolean),
    dueNow: due,
    nonRefundableAck: needAck ? nonRefundableAck : undefined,
    marketingOptIn: form.get("marketing") === "on",
  };

  // Open Channel booking payload. Each room's (promo-adjusted) total is spread
  // across the stay nights as days[], so the price we send is exactly what we
  // charge — no separate "amount" override needed.
  const stayDates = Array.from({ length: nights }, (_, i) =>
    format(addDays(parseISO(stay.checkin), i), "yyyy-MM-dd"),
  );
  const ratio = totals.total > 0 ? discountedTotal / totals.total : 1;
  const booking = {
    status: "new",
    provider_code: config.providerCode,
    hotel_code: stay.channelId,
    ota_name: config.providerCode || "Direct",
    reservation_id: reference,
    currency: stay.currency,
    arrival_date: stay.checkin,
    departure_date: stay.checkout,
    arrival_hour: g.arrival || undefined,
    customer: { name: g.firstName, surname: g.lastName, mail: g.email, phone: g.phone },
    rooms: lines.map((l, index) => {
      const lineTotal = Math.round(l.total * ratio * 100) / 100;
      const per = Math.round((lineTotal / nights) * 100) / 100;
      return {
        index,
        room_type_code: l.roomId,
        occupancy: {
          adults: l.occupancy.adults,
          children: l.occupancy.children,
          infants: l.occupancy.infants ?? 0,
        },
        guests: [{ name: g.firstName, surname: g.lastName }],
        days: stayDates.map((date, i) => ({
          date,
          // last night absorbs the rounding remainder so days sum to lineTotal
          price: (i === nights - 1 ? Math.round((lineTotal - per * (nights - 1)) * 100) / 100 : per).toFixed(2),
          rate_plan_code: l.rateId,
        })),
      };
    }),
  };

  let status: BookingStatus;
  let channexId: string | undefined;
  let error: string | undefined;

  if (live) {
    try {
      const result = await pushOpenChannelBooking(booking);
      channexId = result?.reservation_id || result?.id || undefined;
      status = "confirmed";
    } catch (e) {
      status = "failed";
      error = e instanceof Error ? e.message : "Channex rejected the booking.";
    }
  } else {
    status = "simulated";
  }

  const cancellation = await resolveBookingCancellation(
    stay.channelId,
    lines.map((l) => l.rateId),
    stay.checkin,
  );
  await recordBooking(stay.channelId, {
    id: crypto.randomUUID(),
    reference,
    channexId,
    status,
    error,
    lifecycle: "active",
    cancellation,
    createdAt: new Date().toISOString(),
    currency: stay.currency,
    checkin: stay.checkin,
    checkout: stay.checkout,
    nights,
    total: grandTotal,
    promo: applied ?? undefined,
    offer: offer ?? undefined,
    extras: extraLines.length ? extraLines : undefined,
    consent,
    inventoryHeld: status !== "failed",
    guest: {
      firstName: g.firstName,
      lastName: g.lastName,
      email: g.email,
      phone: g.phone,
      arrival: g.arrival || undefined,
      requests: g.requests || undefined,
    },
    rooms: lines.map((l) => ({
      roomId: l.roomId,
      roomTitle: l.roomTitle,
      rateId: l.rateId,
      rateTitle: l.rateTitle,
      adults: l.occupancy.adults,
      children: l.occupancy.children,
      total: l.total,
    })),
  });

  if (status === "failed") {
    return { bookingError: error };
  }

  // Decrement availability for the booked rooms across the stay nights. A room
  // can only reach checkout if it had a positive availability row for every
  // night (the booking gate enforces this), so each decrement hits a real row.
  await decrementAvailability(stay.channelId, stayAvailabilityItems(lines, stay.checkin, nights));

  const next = new URLSearchParams(url.searchParams);
  next.set("sim", live ? "0" : "1");
  if (applied) next.set("promo", applied.code);
  return redirect(`/${params.channelId}/confirmation/${reference}?${next.toString()}`);
}

function Field({
  name,
  label,
  type = "text",
  placeholder,
  error,
}: {
  name: string;
  label: string;
  type?: string;
  placeholder?: string;
  error?: string[];
}) {
  return (
    <label className="block text-[13px] font-semibold text-secondary">
      {label}
      <input
        name={name}
        type={type}
        placeholder={placeholder}
        className="mt-[7px] block w-full rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[13px] text-[15px] text-ink outline-none focus:border-accent"
      />
      {error?.[0] && (
        <span className="mt-1 block text-[12px] font-normal text-red-600">{error[0]}</span>
      )}
    </label>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-secondary">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

export default function Checkout({ loaderData, actionData, params }: Route.ComponentProps) {
  const { stay, lines, nights, totals, text, offer, originalSubtotal, extraLines, policy, cancellation, termsUrl, privacyUrl } = loaderData;
  const { currency, hotelName } = useProperty();
  const tr = useT();
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
  const submitting = nav.state === "submitting";

  const discount = appliedPromo?.discount ?? 0;
  const discountedRoom = Math.round((totals.total - discount) * 100) / 100;
  const adults = lines.reduce((s, l) => s + l.occupancy.adults, 0);
  const children = lines.reduce((s, l) => s + l.occupancy.children, 0);
  const cleaningFee = lines.reduce((s, l) => s + l.cleaningFee, 0);
  const pricing = computePricing(
    {
      base: discountedRoom,
      nights,
      adults,
      children,
      rooms: lines.length,
      cleaningFee,
      taxableExtras: taxableExtrasTotal(extraLines),
    },
    loaderData.taxConfig,
  );
  const grandTotal = Math.round((pricing.total + untaxedExtrasTotal(extraLines)) * 100) / 100;

  // ---- payment + policy summary (display only; no real charging) ----
  const due = dueNow(policy, grandTotal, nights);
  const atHotel = Math.round((grandTotal - due) * 100) / 100;
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
  // Cancellation: the override note wins; else the translated free-until / non-refundable line.
  const cancelMsg = cancellationMessage(policyToCancellation(policy, stay.checkin), Date.now());
  const cancellationText =
    policy.overrideNote ||
    (cancelMsg ? tr.t(cancelMsg.key, "iso" in cancelMsg ? { date: fmt(parseISO(cancelMsg.iso), "EEE d MMM yyyy") } : undefined) : "");
  const tier0 = policy.cancellation.tiers[0];
  const latePhrase =
    policy.cancellation.refundable && tier0 && tier0.penalty !== "none" && !policy.overrideNote
      ? penaltyPhrase(tier0.penalty, tier0.penaltyValue)
      : "";
  const noShowPhrase = policy.noShow.penalty !== "none" ? penaltyPhrase(policy.noShow.penalty, policy.noShow.penaltyValue) : "";

  // ---- consent ----
  const nonRefundable = !policy.cancellation.refundable;
  const needAck = nonRefundable || due > 0;
  const ackText = nonRefundable
    ? due > 0
      ? `I understand this booking is non-refundable and my card will be charged ${formatMoney(due, currency)} today.`
      : "I understand this booking is non-refundable."
    : `I understand my card will be charged ${formatMoney(due, currency)} today.`;
  const [agree, setAgree] = useState(false);
  const [ack, setAck] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [consentError, setConsentError] = useState(false);
  const showConsentError = consentError || (!!actionData && "consentError" in actionData && actionData.consentError === true);
  const checkboxCls = "mt-0.5 h-4 w-4 flex-none rounded border-line-alt text-accent focus:ring-accent";

  return (
    <main className="mx-auto max-w-[1160px] px-7 pb-[72px] pt-9">
      <Link
        to={`/${params.channelId}/rooms?${searchParams.toString()}`}
        className="mb-[18px] inline-block text-sm font-semibold text-muted hover:text-accent"
      >
        ← {tr.t("allRooms")}
      </Link>
      <h1 className="mb-7 font-serif text-[38px] font-medium tracking-[-0.02em]">{text.heading}</h1>

      {bookingError && (
        <div className="mb-6 rounded-[12px] border border-red-200 bg-red-50 px-4 py-3 text-[14px] text-red-700">
          {bookingError}
        </div>
      )}

      <Form method="post" className="flex flex-wrap items-start gap-9">
        <div className="flex min-w-[340px] flex-[1.5] flex-col gap-7">
          <section className="rounded-[16px] border border-line bg-surface p-[26px]">
            <h3 className="mb-[18px] font-serif text-[20px] font-semibold">{text.guestSection}</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field name="firstName" label={tr.t("firstName")} placeholder="Jamie" error={errors?.firstName} />
              <Field name="lastName" label={tr.t("lastName")} placeholder="Doyle" error={errors?.lastName} />
              <Field name="email" label={tr.t("email")} type="email" placeholder="jamie@email.com" error={errors?.email} />
              <Field name="phone" label={tr.t("phone")} placeholder="+44 …" error={errors?.phone} />
            </div>
          </section>

          <section className="rounded-[16px] border border-line bg-surface p-[26px]">
            <h3 className="mb-[18px] font-serif text-[20px] font-semibold">{text.arrivalSection}</h3>
            <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field name="arrival" label={tr.t("estimatedArrival")} placeholder="15:00" />
            </div>
            <label className="block text-[13px] font-semibold text-secondary">
              {tr.t("specialRequests")}
              <textarea
                name="requests"
                rows={3}
                placeholder="Quiet room, early check-in, anything we should know…"
                className="mt-[7px] block w-full resize-y rounded-[10px] border border-line-alt bg-surface-alt px-3.5 py-[13px] text-[15px] text-ink outline-none focus:border-accent"
              />
            </label>
          </section>

          <section className="rounded-[16px] border border-line bg-surface p-[26px]">
            <h3 className="mb-3 font-serif text-[20px] font-semibold">{text.paymentSection}</h3>

            <div className="mb-3 flex flex-col gap-1.5 text-[14.5px]">
              <div className="flex justify-between">
                <span className="text-secondary">{tr.t("dueNow")}</span>
                <span className="font-semibold">{formatMoney(due, currency)}</span>
              </div>
              {atHotel > 0 && (
                <div className="flex justify-between">
                  <span className="text-secondary">{tr.t("dueAtHotel")}</span>
                  <span className="font-semibold">{formatMoney(atHotel, currency)}</span>
                </div>
              )}
            </div>
            <p className="mb-[18px] text-sm leading-[1.55] text-muted">
              {cardCharged ? tr.t("cardChargedNote") : tr.t("cardGuaranteeNote")}
            </p>

            {(cancellationText || latePhrase || noShowPhrase) && (
              <div className="mb-[18px] flex flex-col gap-1.5 border-t border-divider pt-3.5 text-[13.5px] text-secondary">
                {cancellationText && <div>{cancellationText}</div>}
                {latePhrase && <div className="text-muted-2">{tr.t("afterDeadlineCharge", { penalty: latePhrase })}</div>}
                {noShowPhrase && <div className="text-muted-2">{tr.t("noShowCharge", { penalty: noShowPhrase })}</div>}
              </div>
            )}

            <div className="rounded-[10px] border border-dashed border-[#d8cdb9] bg-[#fbf7f0] p-[18px] text-[13px] text-muted-2">
              {tr.t("cardPlaceholder")}
            </div>
          </section>
        </div>

        {/* summary */}
        <aside
          className="sticky top-24 min-w-[300px] flex-1 rounded-[18px] border border-line bg-surface p-6"
          style={{ boxShadow: "var(--shadow-sticky)" }}
        >
          <h3 className="mb-4 font-serif text-[21px] font-semibold">
            {tr.p("yourStayRooms", lines.length)}
          </h3>
          <div className="flex flex-col gap-3 border-b border-divider pb-4">
            {lines.map((l, i) => (
              <div key={`${l.roomId}-${i}`} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[14.5px] font-semibold">{l.roomTitle}</div>
                  <div className="text-[12.5px] text-muted-2">{l.rateTitle}</div>
                </div>
                <span className="whitespace-nowrap text-[14px] font-semibold">
                  {formatMoney(l.originalTotal, currency)}
                </span>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2.5 border-b border-divider py-4 text-[14.5px]">
            <Row label={tr.t("checkIn")} value={fmt(parseISO(stay.checkin), "EEE d MMM")} />
            <Row label={tr.t("checkOut")} value={fmt(parseISO(stay.checkout), "EEE d MMM")} />
            <Row label={tr.t("nights")} value={String(nights)} />
            <Row label={tr.t("guests")} value={occLabel(tr, stay.occ.adults, stay.occ.childrenAge)} />
          </div>
          {(offer || (discount > 0 && appliedPromo)) && (
            <div className="flex flex-col gap-2.5 border-b border-divider py-4 text-[14.5px]">
              <Row label={tr.t("subtotal")} value={formatMoney(originalSubtotal, currency)} />
              {offer && offer.discount > 0 && (
                <div className="flex justify-between text-[#3f7a52]">
                  <span>
                    {offer.name} (−{offer.value}%)
                  </span>
                  <span className="font-semibold">−{formatMoney(offer.discount, currency)}</span>
                </div>
              )}
              {discount > 0 && appliedPromo && (
                <div className="flex justify-between text-[#3f7a52]">
                  <span>
                    {tr.t("discount")} ({appliedPromo.code})
                  </span>
                  <span className="font-semibold">−{formatMoney(discount, currency)}</span>
                </div>
              )}
            </div>
          )}

          {/* promo code */}
          <div className="border-b border-divider py-4">
            <label className="block text-[12px] font-semibold uppercase tracking-wide text-muted-2">
              {tr.t("promoCode")}
            </label>
            <div className="mt-2 flex gap-2">
              <input
                name="promoCode"
                defaultValue={promoCodeValue}
                placeholder="SUMMER10"
                autoComplete="off"
                className="min-w-0 flex-1 rounded-[10px] border border-line-alt bg-surface-alt px-3 py-2.5 text-[14px] uppercase text-ink outline-none focus:border-accent"
              />
              <button
                type="submit"
                name="intent"
                value="applyPromo"
                formNoValidate
                disabled={submitting}
                className="flex-none rounded-[10px] border border-line-alt bg-surface px-4 py-2.5 text-[13px] font-semibold text-ink hover:border-accent hover:text-accent disabled:opacity-60"
              >
                {tr.t("applyCode")}
              </button>
            </div>
            {promoError && <p className="mt-1.5 text-[12px] text-red-600">{tr.t("promoInvalid")}</p>}
            {appliedPromo && discount > 0 && (
              <p className="mt-1.5 text-[12px] text-[#3f7a52]">{tr.t("promoApplied")}</p>
            )}
          </div>

          {extraLines.length > 0 && (
            <div className="flex flex-col gap-3 border-b border-divider py-4 text-[14px]">
              <div className="text-[12px] font-semibold uppercase tracking-wide text-muted-2">{tr.t("extrasLabel")}</div>
              {groupExtrasByRoom(extraLines).map((g, gi) => (
                <div key={gi} className="flex flex-col gap-1.5">
                  <div className="text-[12.5px] font-semibold text-secondary">{g.roomTitle ?? tr.t("forYourStay")}</div>
                  {g.lines.map((l) => (
                    <div key={`${l.id}-${l.optionId ?? ""}`} className="flex items-start justify-between gap-3 pl-2">
                      <div className="min-w-0">
                        <span>
                          {l.optionName ? `${l.name} · ${l.optionName}` : l.name}
                          {l.qty > 1 ? ` ×${l.qty}` : ""}
                        </span>
                        {l.infoLine && <div className="text-[12px] text-muted-2">{l.infoLine}</div>}
                      </div>
                      <span className="whitespace-nowrap font-semibold">{formatMoney(l.amount, currency)}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {(pricing.charges.length > 0 || pricing.taxLines.length > 0) && (
            <div className="flex flex-col gap-2.5 border-b border-divider py-4 text-[14px]">
              {pricing.charges.map((c, i) => (
                <Row key={`charge-${i}`} label={c.label} value={formatMoney(c.amount, currency)} />
              ))}
              {pricing.taxLines.map((c, i) => (
                <Row key={`tax-${i}`} label={c.label} value={formatMoney(c.amount, currency)} />
              ))}
            </div>
          )}

          <div className="flex items-baseline justify-between pt-4">
            <span className="text-[16px] font-semibold">{tr.t("total")}</span>
            <span className="font-serif text-[30px] font-semibold">
              {formatMoney(grandTotal, currency)}
            </span>
          </div>
          {pricing.taxIncluded > 0 && (
            <p className="pb-4 pt-1 text-right text-[12px] text-muted-2">
              {tr.t("includesTaxes", { amount: formatMoney(pricing.taxIncluded, currency) })}
            </p>
          )}

          {/* consent — required ticks sit directly above the booking button */}
          <div className="mb-3 flex flex-col gap-2.5 border-t border-divider pt-4">
            <label className="flex items-start gap-2.5 text-[13px] leading-[1.5] text-secondary">
              <input
                type="checkbox"
                name="consent"
                checked={agree}
                onChange={(e) => { setAgree(e.target.checked); setConsentError(false); }}
                className={checkboxCls}
              />
              <span>
                I agree to the booking conditions, the cancellation policy shown above, and the{" "}
                {termsUrl ? (
                  <a href={termsUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-accent underline">Terms &amp; Conditions</a>
                ) : (
                  <span className="font-semibold">Terms &amp; Conditions</span>
                )}{" "}
                and{" "}
                {privacyUrl ? (
                  <a href={privacyUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-accent underline">Privacy Policy</a>
                ) : (
                  <span className="font-semibold">Privacy Policy</span>
                )}.
              </span>
            </label>

            {needAck && (
              <label className="flex items-start gap-2.5 text-[13px] leading-[1.5] text-secondary">
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

            <label className="flex items-start gap-2.5 text-[13px] leading-[1.5] text-muted">
              <input
                type="checkbox"
                name="marketing"
                checked={marketing}
                onChange={(e) => setMarketing(e.target.checked)}
                className={checkboxCls}
              />
              <span>Send me offers and news{hotelName ? ` from ${hotelName}` : ""}.</span>
            </label>

            {showConsentError && (
              <p className="text-[12.5px] font-medium text-red-600">
                Please tick the required boxes to continue.
              </p>
            )}
          </div>

          <button
            type="submit"
            name="intent"
            value="book"
            disabled={submitting}
            onClick={(e) => {
              if (!agree || (needAck && !ack)) {
                e.preventDefault();
                setConsentError(true);
              }
            }}
            className="w-full rounded-[12px] bg-accent py-[15px] text-[16px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:opacity-60"
          >
            {submitting ? tr.t("confirming") : text.completeButton}
          </button>
          <div className="mt-3 text-center text-[12.5px] leading-[1.5] text-muted-2">
            {text.cancellationNote}
          </div>
        </aside>
      </Form>
    </main>
  );
}
