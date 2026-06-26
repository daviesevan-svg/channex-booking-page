import { addDays, differenceInCalendarDays, format, parseISO } from "date-fns";
import { Form, Link, redirect, useNavigation, useSearchParams } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/checkout";
import type { RoomWithRates } from "~/lib/channex/types";
import { useProperty } from "~/lib/booking-context";
import {
  cartCoverage,
  cartCovers,
  parseCart,
  resolveCart,
  withinAvailability,
  type ResolvedLine,
} from "~/lib/cart";
import {
  generateReference,
  recordBooking,
  stayAvailabilityItems,
  type BookingStatus,
} from "~/lib/bookings.server";
import { resolveBookingCancellation } from "~/lib/policy.server";
import { resolveAppliedPromo } from "~/lib/promotions.server";
import { normalizeCode, type AppliedPromo } from "~/lib/promotions";
import { getConfig } from "~/lib/config.server";
import { getSettings } from "~/lib/overrides.server";
import { computePricing, taxConfigFrom } from "~/lib/pricing";
import { pushOpenChannelBooking } from "~/lib/open-channel.server";
import { formatMoney } from "~/lib/money";
import { readOccupancy, type Occupancy } from "~/lib/occupancy";
import { occLabel, useT } from "~/lib/i18n";
import { langFromRequest } from "~/lib/content";
import { getPageText } from "~/lib/overrides.server";
import { getCatalogRooms } from "~/lib/catalog.server";
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
    },
    { gate: true },
  );
  return { rooms, lines: resolveCart(parseCart(url.searchParams), rooms) };
}

/** Derive the automatic offer baked into the resolved lines (by getCatalogRooms)
 *  plus each line's pre-discount price, so checkout can itemise the saving. */
function deriveOffer(lines: ResolvedLine[], rooms: RoomWithRates[]) {
  let name = "";
  let percent = 0;
  let hasOffer = false;
  const view = lines.map((l) => {
    const rp = rooms.find((r) => r.id === l.roomId)?.ratePlans.find((p) => p.id === l.rateId);
    if (rp?.offer) {
      hasOffer = true;
      name = rp.offer.name;
      percent = rp.offer.percent;
    }
    return { ...l, originalTotal: rp?.offer ? Number(rp.offer.originalTotalPrice) : l.total };
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
  const { offer, originalSubtotal, lines: linesView } = deriveOffer(lines, rooms);
  // A promo carried from the landing page (?promo=) is pre-applied here so the
  // guest sees the discount immediately.
  const urlPromo = await resolveAppliedPromo(params.channelId, url.searchParams.get("promo") || "", totals.total);
  return {
    stay,
    lines: linesView,
    nights,
    totals,
    originalSubtotal,
    offer,
    text,
    urlPromo,
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
  const { offer } = deriveOffer(lines, rooms);

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
  const pricing = computePricing(
    { base: discountedTotal, nights, adults, children, rooms: lines.length, cleaningFee },
    taxConfigFrom(settings),
  );

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
    total: pricing.total,
    promo: applied ?? undefined,
    offer: offer ?? undefined,
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

  // Decrement availability for the booked rooms across the stay nights (rooms
  // with no availability row are treated as unlimited and left untouched).
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
  const { stay, lines, nights, totals, text, offer, originalSubtotal } = loaderData;
  const { currency } = useProperty();
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
    { base: discountedRoom, nights, adults, children, rooms: lines.length, cleaningFee },
    loaderData.taxConfig,
  );
  const grandTotal = pricing.total;

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
            <h3 className="mb-2 font-serif text-[20px] font-semibold">{text.paymentSection}</h3>
            <p className="mb-[18px] whitespace-pre-line text-sm leading-[1.55] text-muted">
              {text.paymentNote}
            </p>
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
          <button
            type="submit"
            name="intent"
            value="book"
            disabled={submitting}
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
