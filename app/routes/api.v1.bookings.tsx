import { z } from "zod";

import type { Route } from "./+types/api.v1.bookings";
import { authenticateApiKey, apiError } from "~/lib/api-auth.server";
import { getBookings, generateReference } from "~/lib/bookings.server";
import { serializeBooking } from "~/lib/api-serialize";
import { getConfig, getConfigKV } from "~/lib/config.server";
import { getSettings, getBookingCutoff } from "~/lib/overrides.server";
import { isStayBookable, isTooLastMinute } from "~/lib/dates";
import { getCatalogRooms, resolveCartByOccupancy } from "~/lib/catalog.server";
import { cartCoverage, withinAvailability, serializeCart, type CartLine, type ResolvedLine } from "~/lib/cart";
import {
  extraEligible,
  isConfigurable,
  resolveAllExtras,
  scopeOf,
  taxableExtrasTotal,
  untaxedExtrasTotal,
  type Extra,
  type ExtraContextLine,
  type ExtraSelection,
  type ResolvedExtra,
} from "~/lib/extras";
import { getActiveExtras } from "~/lib/extras.server";
import { computePricing, taxConfigFrom } from "~/lib/pricing";
import { resolveBookingPolicy } from "~/lib/policy.server";
import { dueNow, policyToCancellation } from "~/lib/policy-copy";
import { describePolicy } from "~/lib/rate-policy";
import { resolveAppliedPromo } from "~/lib/promotions.server";
import type { AppliedPromo } from "~/lib/promotions";
import { preparePendingBooking } from "~/lib/booking-create.server";
import { finalizeBooking } from "~/lib/booking-finalize.server";
import { stashPending } from "~/lib/pending-bookings.server";
import { createCheckoutSession } from "~/lib/stripe.server";

// GET /v1/bookings?limit=&offset= — the property's bookings, newest first.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request);
  if (auth instanceof Response) return auth;
  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
  const all = await getBookings(auth.pid);
  return Response.json({ data: all.slice(offset, offset + limit).map(serializeBooking), total: all.length, limit, offset });
}

// An add-on selection. Only ids/qty/info travel — prices are always resolved
// server-side from the extras catalog (same as the hosted checkout).
const ExtraSel = z.object({
  extra_id: z.string().min(1),
  option_id: z.string().min(1).optional(),
  qty: z.number().int().min(1).max(99).optional(),
  /** Values for the extra's info fields, keyed by field id. */
  info: z.record(z.string(), z.string()).optional(),
});

const Body = z.object({
  checkin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkout: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // currency is intentionally NOT accepted — prices are always the property's own
  // currency (no conversion), so trusting a client value would mis-denominate.
  rooms: z
    .array(
      z.object({
        room_id: z.string().min(1),
        rate_id: z.string().min(1),
        adults: z.number().int().positive().optional(),
        children_ages: z.array(z.number().int().min(0)).optional(),
        /** Room-scoped add-ons for this room (see GET /v1/extras). */
        extras: z.array(ExtraSel).optional(),
      }),
    )
    .min(1),
  /** Booking-scoped add-ons, offered once for the whole stay. */
  extras: z.array(ExtraSel).optional(),
  guest: z.object({
    first_name: z.string().min(1),
    last_name: z.string().min(1),
    email: z.string().email(),
    phone: z.string().min(3),
    arrival: z.string().optional(),
    requests: z.string().optional(),
  }),
  promo_code: z.string().optional(),
  marketing_opt_in: z.boolean().optional(),
});

/** Why an extras selection can't be booked, or null when it's valid. The web
 *  checkout silently drops invalid selections (the guest sees the re-priced
 *  cart); an API client gets no such feedback, so a bad selection must be a
 *  hard 422 — otherwise "breakfast" silently vanishes from a paid booking. */
function extraSelectionError(
  catalog: Extra[],
  sel: z.infer<typeof ExtraSel>,
  ctx: { scope: "room" | "booking"; roomId?: string; rateId?: string },
): string | null {
  const extra = catalog.find((e) => e.id === sel.extra_id);
  if (!extra) return `extra ${sel.extra_id} does not exist or is not active`;
  if (scopeOf(extra) !== ctx.scope) {
    return scopeOf(extra) === "booking"
      ? `"${extra.name}" is a whole-stay extra — send it in the top-level \`extras\` array, not on a room`
      : `"${extra.name}" is a per-room extra — send it on a room's \`extras\` array`;
  }
  if (ctx.scope === "room" && !extraEligible(extra, ctx.roomId ?? "", ctx.rateId ?? "")) {
    return `"${extra.name}" is not offered for that room/rate`;
  }
  if (isConfigurable(extra)) {
    if (!sel.option_id) return `"${extra.name}" requires \`option_id\` (see its options in GET /v1/extras)`;
    if (!extra.options!.some((o) => o.id === sel.option_id)) return `"${extra.name}" has no option ${sel.option_id}`;
  }
  for (const f of extra.fields ?? []) {
    if (f.required && !sel.info?.[f.id]?.trim()) return `"${extra.name}" requires info field "${f.id}" (${f.label})`;
  }
  return null;
}

const toSelection = (s: z.infer<typeof ExtraSel>): ExtraSelection => ({
  id: s.extra_id,
  optionId: s.option_id,
  qty: s.qty ?? 1,
  info: s.info,
});

/** The automatic offer baked into line prices (mirror of checkout's deriveOffer). */
function offerFromLines(lines: ResolvedLine[]): AppliedPromo | undefined {
  let name = "";
  let percent = 0;
  let has = false;
  for (const l of lines) {
    const orig = l.originalTotal ?? l.total;
    if (l.offerName != null && l.offerPercent != null && orig > l.total) {
      has = true;
      name = l.offerName;
      percent = l.offerPercent;
    }
  }
  if (!has) return undefined;
  const original = Math.round(lines.reduce((s, l) => s + (l.originalTotal ?? l.total), 0) * 100) / 100;
  const sale = Math.round(lines.reduce((s, l) => s + l.total, 0) * 100) / 100;
  return { name, type: "percent", value: percent, discount: Math.round((original - sale) * 100) / 100 };
}

// POST /v1/bookings — create a booking. Pay-at-hotel rates confirm immediately;
// rates needing online payment return a `payment_url` (Stripe hosted Checkout)
// and finalize on payment via the existing return URL + webhook.
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return apiError(405, "method_not_allowed", "Use POST to create a booking.");
  const auth = await authenticateApiKey(request);
  if (auth instanceof Response) return auth;
  const { pid, mode } = auth;
  const kv = getConfigKV();
  const idemKey = request.headers.get("Idempotency-Key");
  const idemStore = idemKey ? `idem:${pid}:${idemKey}` : null;

  // Idempotency: replay the cached response for a repeated key.
  if (idemStore && kv) {
    const cached = await kv.get(idemStore);
    if (cached) {
      const { status, body } = JSON.parse(cached) as { status: number; body: unknown };
      return Response.json(body, { status });
    }
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") : "Invalid JSON body.";
    return apiError(422, "invalid_request", msg);
  }

  const { checkin, checkout } = body;
  // Currency is the property's configured currency — never client input. There's
  // no conversion, so trusting body.currency would just re-denominate the charge.
  const settings = await getSettings(pid);
  const currency = (settings.currency || "GBP").toUpperCase();
  if (!isStayBookable(checkin, checkout)) return apiError(422, "invalid_request", "Check-out must be after check-in, in the future.");
  if (isTooLastMinute(checkin, await getBookingCutoff(pid))) return apiError(422, "invalid_request", "Check-in is within the booking cut-off window.");

  const cartLines: CartLine[] = body.rooms.map((r) => ({
    roomId: r.room_id,
    rateId: r.rate_id,
    adults: r.adults,
    childrenAge: r.children_ages,
  }));
  const searched = { adults: body.rooms[0].adults ?? 2, childrenAge: body.rooms[0].children_ages ?? [] };

  const rooms = await getCatalogRooms(pid, { checkinDate: checkin, checkoutDate: checkout, currency, adults: searched.adults, childrenAge: searched.childrenAge }, { gate: true });
  const lines = await resolveCartByOccupancy(pid, { checkin, checkout, currency }, cartLines, searched);
  if (lines.length !== cartLines.length || !withinAvailability(cartLines, rooms)) {
    return apiError(422, "unavailable", "One or more of the requested rooms/rates is not available for those dates or occupancy.");
  }

  const config = getConfig();
  const nights = Math.max(1, Math.round((Date.parse(checkout) - Date.parse(checkin)) / 86400000));
  const reference = generateReference();

  // Promo (re-resolved server-side) + automatic offer.
  const totals = cartCoverage(lines);
  const applied = body.promo_code ? await resolveAppliedPromo(pid, body.promo_code, totals.total) : null;
  if (body.promo_code && !applied) return apiError(422, "invalid_promo", "That promo code isn't valid for this booking.");
  const offer = offerFromLines(lines);
  const discount = applied?.discount ?? 0;
  const discountedTotal = Math.round((totals.total - discount) * 100) / 100;

  const adults = lines.reduce((s, l) => s + l.occupancy.adults, 0);
  const children = lines.reduce((s, l) => s + l.occupancy.children, 0);
  const cleaningFee = lines.reduce((s, l) => s + l.cleaningFee, 0);

  // Add-ons: reject any invalid selection outright (never silently drop a paid
  // extra), then price authoritatively from the catalog — mirroring checkout.
  // `lines` preserves body.rooms order, so per-room buckets align by index.
  let extraLines: ResolvedExtra[] = [];
  if (body.rooms.some((r) => r.extras?.length) || body.extras?.length) {
    const catalog = await getActiveExtras(pid);
    for (const [i, r] of body.rooms.entries()) {
      for (const sel of r.extras ?? []) {
        const err = extraSelectionError(catalog, sel, { scope: "room", roomId: r.room_id, rateId: r.rate_id });
        if (err) return apiError(422, "invalid_extra", `rooms[${i}].extras: ${err}`);
      }
    }
    for (const sel of body.extras ?? []) {
      const err = extraSelectionError(catalog, sel, { scope: "booking" });
      if (err) return apiError(422, "invalid_extra", `extras: ${err}`);
    }
    const ctx: ExtraContextLine[] = lines.map((l) => ({
      roomId: l.roomId,
      rateId: l.rateId,
      roomTitle: l.roomTitle,
      guests: l.occupancy.adults + l.occupancy.children,
    }));
    extraLines = resolveAllExtras(
      catalog,
      { lines: body.rooms.map((r) => (r.extras ?? []).map(toSelection)), booking: (body.extras ?? []).map(toSelection) },
      ctx,
      nights,
      adults + children,
    );
  }

  const pricing = computePricing(
    { base: discountedTotal, nights, adults, children, rooms: lines.length, cleaningFee, taxableExtras: taxableExtrasTotal(extraLines), checkin },
    taxConfigFrom(settings),
  );
  // VAT-exempt extras ride on top of the taxed total untouched (same as checkout).
  const grandTotal = Math.round((pricing.total + untaxedExtrasTotal(extraLines)) * 100) / 100;

  const policy = await resolveBookingPolicy(pid, lines.map((l) => l.rateId));
  const due = dueNow(policy, grandTotal, nights);
  const cancelInfo = policyToCancellation(policy, checkin);
  const freeWindowClosed = cancelInfo.refundable && cancelInfo.cancelByISO != null && Date.now() > Date.parse(cancelInfo.cancelByISO);
  const needAck = !policy.cancellation.refundable || freeWindowClosed || due > 0;
  const desc = describePolicy(policy);

  // test-mode keys never push to Channex; live keys honour the property's setting.
  const live = mode === "live" && (settings.liveBooking ?? config.allowLiveBooking) && settings.connectedSystem === "channex";
  const origin = new URL(request.url).origin;

  const rp = new URLSearchParams();
  rp.set("checkin", checkin);
  rp.set("checkout", checkout);
  rp.set("currency", currency);
  rp.set("adults", String(adults));
  rp.set("sel", serializeCart(cartLines));
  rp.set("sim", live ? "0" : "1");
  if (applied?.code) rp.set("promo", applied.code);

  const pending = await preparePendingBooking({
    pid,
    reference,
    checkin,
    checkout,
    currency,
    nights,
    lines,
    pricing: { charges: pricing.charges, taxLines: pricing.taxLines, taxIncluded: pricing.taxIncluded },
    guest: {
      firstName: body.guest.first_name,
      lastName: body.guest.last_name,
      email: body.guest.email,
      phone: body.guest.phone,
      arrival: body.guest.arrival || undefined,
      requests: body.guest.requests || undefined,
    },
    grandTotal,
    baseTotal: totals.total,
    discountedTotal,
    applied: applied ?? undefined,
    offer,
    extraLines,
    consent: {
      acceptedAt: new Date().toISOString(),
      ip: request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined,
      userAgent: request.headers.get("user-agent") || undefined,
      policyText: [desc.payment, desc.cancellation, desc.noShow].filter(Boolean),
      dueNow: due,
      nonRefundableAck: needAck ? true : undefined,
      marketingOptIn: body.marketing_opt_in ?? false,
    },
    lang: "en",
    live,
    account: settings.stripeAccountId ?? "",
    origin,
    returnParams: rp.toString(),
    providerCode: config.providerCode,
  });

  const stripeConnected = Boolean(settings.stripeAccountId && config.stripeSecretKey);
  const needsGuarantee = due === 0 && policy.payment.card === "guarantee";
  const stripeMode: "payment" | "setup" | null = due > 0 ? "payment" : needsGuarantee ? "setup" : null;

  const respond = async (status: number, bodyOut: unknown) => {
    if (idemStore && kv) await kv.put(idemStore, JSON.stringify({ status, body: bodyOut }), { expirationTtl: 24 * 3600 });
    return Response.json(bodyOut, { status });
  };

  // A paid rate with no way to charge must not book unpaid.
  if (due > 0 && !stripeConnected) {
    return apiError(422, "payment_not_configured", "This rate requires online payment, but card payments aren't set up for this property.");
  }

  if (stripeMode && stripeConnected) {
    const account = settings.stripeAccountId as string;
    await stashPending(reference, pending);
    const common = {
      client_reference_id: reference,
      customer_email: body.guest.email,
      metadata: { reference, pid },
      // Must expire INSIDE the pending stash TTL (3h) — otherwise a guest paying
      // after the stash lapses is charged with no pending record to finalize, so
      // no booking and no refund. Mirrors the web checkout's 60-minute window.
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
      success_url: `${origin}/${pid}/checkout/complete?session_id={CHECKOUT_SESSION_ID}&ref=${reference}&${rp.toString()}`,
      cancel_url: `${origin}/${pid}`,
    };
    const params =
      stripeMode === "payment"
        ? {
            ...common,
            mode: "payment",
            payment_intent_data: { description: `Booking ${reference}`, metadata: { reference, pid } },
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency: currency.toLowerCase(),
                  unit_amount: Math.round(due * 100),
                  product_data: { name: `Booking ${reference}`, description: `${checkin} – ${checkout} · ${nights} night${nights !== 1 ? "s" : ""}` },
                },
              },
            ],
          }
        : {
            ...common,
            mode: "setup",
            currency: currency.toLowerCase(), // required for setup sessions (no line items)
            setup_intent_data: { metadata: { reference, pid } },
          };
    let url: string | undefined;
    try {
      url = (await createCheckoutSession(account, params, reference)).url;
    } catch (e) {
      console.log(`[api] stripe session failed pid=${pid} acct=${account}: ${e instanceof Error ? e.message : e}`);
      return apiError(502, "payment_error", "Couldn't start the payment session. Please try again.");
    }
    if (!url) return apiError(502, "payment_error", "Couldn't start the payment session. Please try again.");
    return respond(201, { data: { reference, status: "pending_payment", amount_due: due, currency }, payment_url: url });
  }

  // No online payment needed — create the booking now.
  const record = await finalizeBooking(pending, undefined, origin);
  return respond(201, { data: serializeBooking(record) });
}
