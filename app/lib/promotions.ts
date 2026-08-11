// Promotions — client-safe types and pure discount logic. The KV-backed CRUD
// lives in promotions.server.ts.
//
// Two triggers, both stored as a Promotion:
//  - trigger "code": the guest types a code at checkout (percent or fixed off).
//  - trigger "auto": a rule-based offer that applies with no code when its
//    conditions match the stay (e.g. "book 60+ days ahead → 10% off"). Auto
//    offers are percent-only so the discount can be shown per-room while
//    browsing, and the % is baked into rate prices in getCatalogRooms.
//
// …and two KINDS, on a separate axis (see PromoKind):
//  - "discount": moves money. Everything above.
//  - "value_add": moves nothing and includes something — dinner, a late
//    checkout. Auto-only for now; `type`/`value` are ignored. A stay can carry
//    one discount AND its value-adds at once, because they are answers to
//    different questions, unless a matching value-add is `exclusive`.
//
// The bottom half of this file turns a stored Promotion into what the website's
// offers section and /offers page show — including when it can be booked, which
// is derived from the same conditions `offerMatches` evaluates rather than
// restated. One set of rules, so the page can't promise a discount checkout
// won't give.

export type DiscountType = "percent" | "fixed";
export type PromoTrigger = "code" | "auto";

/**
 * What the guest gets.
 *
 * A value-add is NOT a discount worth zero. `type`/`value` feed computeDiscount,
 * the checkout summary, the booking snapshot, the API and the Google feed —
 * putting a non-money member in DiscountType would mean a branch in every one of
 * them. Kept as its own axis so the money path is untouched and every existing
 * `value > 0` guard keeps meaning what it means.
 *
 * Absent = "discount": every promotion written before this field existed is one,
 * and no reader should have to care. Use `kindOf`.
 */
export type PromoKind = "discount" | "value_add";

/** Conditions for an automatic offer. All present conditions must hold (AND). */
export interface PromoConditions {
  /** Early bird: book at least this many days before check-in. */
  minDaysAhead?: number;
  /** Last minute: book at most this many days before check-in. */
  maxDaysAhead?: number;
  /** Length of stay: the stay is at least this many nights. */
  minNights?: number;
  /** Date window: check-in on or after this date (YYYY-MM-DD). */
  stayFrom?: string;
  /** Date window: check-out on or before this date (YYYY-MM-DD). */
  stayTo?: string;
  /**
   * Check-in must fall on one of these weekdays. 0 = Sunday … 6 = Saturday,
   * matching Date.getUTCDay().
   *
   * Absent OR EMPTY = any day. An empty array has to mean "any": a hotel that
   * ticks all seven boxes and then unticks them has expressed no preference, and
   * reading that as "no day qualifies" would kill the offer in silence.
   */
  arrivalDays?: number[];
  /** Check-out must fall on one of these weekdays. Same encoding, same rule. */
  departureDays?: number[];
}

export interface Promotion {
  id: string;
  /** "code" = guest enters a code; "auto" = applies by rules, no code. */
  trigger: PromoTrigger;
  /** Code the guest enters (code promos only). Stored normalized; "" for auto. */
  code: string;
  /** Public label for auto offers (shown to guests); internal note for codes. */
  name?: string;
  /** Rules for an auto offer (ignored for code promos). */
  conditions?: PromoConditions;
  /** Discount or included extras. Absent = "discount" — see PromoKind. */
  kind?: PromoKind;
  /** What's included, one line each. Guest-facing. Read only for "value_add",
   *  where an empty list means there is no offer (as `value: 0` does for a
   *  discount). */
  inclusions?: string[];
  /**
   * Don't combine with automatic discounts (value-adds only).
   *
   * Off by default, so the two stack: they're orthogonal, one changes the price
   * and the other changes what's in the room. But a hotel running an early bird
   * alongside a "no discount, you get dinner" package usually means one or the
   * other, and nothing else in the model can say so. When a matching value-add
   * sets this, the stay's automatic discount is suppressed — the package IS the
   * offer. A discount CODE the guest types still applies: refusing it needs an
   * error state at checkout, which is a bigger change than this flag.
   */
  exclusive?: boolean;
  type: DiscountType;
  /** Percent (1–100) or a fixed amount in the property currency. Ignored for a
   *  value-add, which stores 0 rather than leaving the record half-typed. */
  value: number;
  enabled: boolean;
  /**
   * List this promotion on the website's offers page.
   *
   * Unset is not "no": see `isPublishedOffer`. An auto offer already has a
   * guest-facing `name` and already shows up in room prices while browsing, so
   * withholding it from the page it belongs on would be the surprising default.
   * A code's `name` is an internal note, so publishing one has to be a choice
   * somebody made — the alternative is a hotel's own shorthand ("OTA winback,
   * don't honour twice") turning up as a headline.
   */
  publish?: boolean;
  createdAt: string;
}

/** A promotion resolved and applied to a booking. Snapshotted onto the booking
 *  record so the discount is stable after the fact. A code promo carries `code`;
 *  an automatic offer carries `name`. */
export interface AppliedPromo {
  code?: string;
  name?: string;
  type: DiscountType;
  value: number;
  /** The discount amount in the booking currency. */
  discount: number;
}

/** The stay facts an automatic offer's conditions are evaluated against. */
export interface StayContext {
  /** Whole days between the booking date and check-in (lead time). */
  daysAhead: number;
  /** Number of nights in the stay. */
  nights: number;
  /** Check-in date (YYYY-MM-DD), for date-window conditions. */
  checkin?: string;
  /** Check-out date (YYYY-MM-DD), for date-window conditions. */
  checkout?: string;
}

/** Codes are matched case- and whitespace-insensitively. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}

/** The discount amount for a given subtotal — never negative, never more than
 *  the subtotal. Rounded to 2dp. Returns 0 for a disabled promo. */
export function computeDiscount(promo: Promotion, subtotal: number): number {
  if (!promo.enabled || subtotal <= 0) return 0;
  const raw = promo.type === "percent" ? subtotal * (promo.value / 100) : promo.value;
  const capped = Math.min(Math.max(raw, 0), subtotal);
  return Math.round(capped * 100) / 100;
}

/** A promotion's kind, defaulting the field that older records don't have. */
export function kindOf(p: Pick<Promotion, "kind">): PromoKind {
  return p.kind === "value_add" ? "value_add" : "discount";
}

/** The weekday of a YYYY-MM-DD, 0 = Sunday.
 *
 *  Parsed as UTC, like every other date in this module (see `shiftISO`). A local
 *  parse would read a Sunday arrival as Saturday west of Greenwich. */
export function dowOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/** Whether an automatic offer applies to a stay. */
export function offerMatches(p: Promotion, ctx: StayContext): boolean {
  if (!p.enabled || p.trigger !== "auto") return false;
  // An offer with nothing in it isn't an offer, whichever kind it is.
  if (kindOf(p) === "value_add") {
    if (!p.inclusions?.length) return false;
  } else if (p.type !== "percent" || p.value <= 0) {
    return false;
  }
  const c = p.conditions ?? {};
  if (c.minDaysAhead != null && ctx.daysAhead < c.minDaysAhead) return false;
  if (c.maxDaysAhead != null && ctx.daysAhead > c.maxDaysAhead) return false;
  if (c.minNights != null && ctx.nights < c.minNights) return false;
  // Date window — ISO dates compare lexically. When a window is set but we don't
  // know the stay dates, the offer can't be verified, so it doesn't apply.
  if (c.stayFrom && (!ctx.checkin || ctx.checkin < c.stayFrom)) return false;
  if (c.stayTo && (!ctx.checkout || ctx.checkout > c.stayTo)) return false;
  // Weekday rules. Same call as the date window on unknown dates: a rule that
  // can't be checked can't be honoured, so it doesn't apply.
  if (c.arrivalDays?.length && (!ctx.checkin || !c.arrivalDays.includes(dowOf(ctx.checkin)))) return false;
  if (c.departureDays?.length && (!ctx.checkout || !c.departureDays.includes(dowOf(ctx.checkout)))) return false;
  return true;
}

/**
 * The single best automatic DISCOUNT (highest percent) for a stay, or null.
 *
 * Returns null when a matching value-add is `exclusive` — that's the hotel
 * saying the package replaces the discount rather than joining it.
 */
export function bestAutoOffer(promos: Promotion[], ctx: StayContext): Promotion | null {
  if (matchingValueAdds(promos, ctx).some((p) => p.exclusive)) return null;
  let best: Promotion | null = null;
  for (const p of promos) {
    if (kindOf(p) !== "discount") continue;
    if (offerMatches(p, ctx) && (!best || p.value > best.value)) best = p;
  }
  return best;
}

/**
 * Every value-added offer that applies to a stay.
 *
 * All of them, not the "best" one: there is no ordering between a welcome drink
 * and a late checkout, so any tie-break would be arbitrary, and dropping one
 * silently is the sort of thing nobody notices until a guest asks where their
 * dinner is. A hotel that creates two overlapping packages means both.
 */
export function matchingValueAdds(promos: Promotion[], ctx: StayContext): Promotion[] {
  return promos.filter((p) => kindOf(p) === "value_add" && offerMatches(p, ctx));
}

/** One value-add as a guest sees it, with blank lines dropped. */
export interface ValueAddView {
  name: string;
  inclusions: string[];
}

/**
 * Matching value-adds, ready to render.
 *
 * Inclusion lines are deduped ACROSS offers (case- and space-insensitively), so
 * two packages that both promise breakfast say it once. First mention wins, so
 * the line stays with the offer that introduced it.
 */
export function valueAddViews(promos: Promotion[], ctx: StayContext): ValueAddView[] {
  const seen = new Set<string>();
  const out: ValueAddView[] = [];
  for (const p of matchingValueAdds(promos, ctx)) {
    const inclusions: string[] = [];
    for (const line of p.inclusions ?? []) {
      const text = line.trim();
      const key = text.toLowerCase().replace(/\s+/g, " ");
      if (!text || seen.has(key)) continue;
      seen.add(key);
      inclusions.push(text);
    }
    if (inclusions.length) out.push({ name: p.name?.trim() || "", inclusions });
  }
  return out;
}

// ------------------------------------------------------------ public offers

/**
 * Whether a promotion belongs on the website.
 *
 * Disabled is never shown — an offer a guest can't have isn't an offer. Beyond
 * that, `publish` decides, and an unset value means "auto yes, code no" for the
 * reasons on the field itself.
 */
export function isPublishedOffer(p: Promotion): boolean {
  const hasSomething = kindOf(p) === "value_add" ? Boolean(p.inclusions?.length) : p.value > 0;
  return p.enabled && hasSomething && (p.publish ?? p.trigger === "auto");
}

/**
 * One offer as the website shows it.
 *
 * A projection, not the stored record: `publish`, `createdAt` and a code's
 * internal note have no business in the HTML, and a loader that returned the row
 * would serialize all three (the same trap the reviews section documents).
 */
export interface OfferView {
  id: string;
  trigger: PromoTrigger;
  /** The code to type. Present only on a code offer. */
  code?: string;
  /** Guest-facing title. Falls back to the code, never to an internal note. */
  name: string;
  /** "discount" reads `type`/`value`; "value_add" reads `inclusions`. */
  kind: PromoKind;
  type: DiscountType;
  value: number;
  /** What's included (value-adds only). Blank lines already dropped. */
  inclusions?: string[];
  /** Booking rules, echoed so the renderer can write them out as sentences. */
  conditions?: PromoConditions;
  /** Earliest check-in that qualifies for a booking made today. */
  earliestCheckin: string;
  /**
   * Latest check-in that qualifies for a booking made today. Absent = no ceiling.
   *
   * Two things can cap it and the tighter one wins: the stay window's close (less
   * the minimum stay), and a last-minute rule, which says a check-in more than N
   * days out doesn't qualify *yet*. The offer page's calendar greys out arrivals
   * past this, so the guest can't pick dates the discount wouldn't apply to.
   */
  latestCheckin?: string;
  /** Last day a guest can book and still qualify. Absent = no deadline. */
  bookBy?: string;
  /** First day a guest can book — a last-minute rule on a future stay window
   *  isn't open yet. Absent when the offer is already bookable. */
  bookFrom?: string;
  /** "live" = bookable today. "upcoming" = the rules can only be met later.
   *  Offers that can no longer be met at all are dropped, not marked. */
  status: "live" | "upcoming";
}

/** ISO date arithmetic on the calendar day, no timezone in play — every date
 *  here is a YYYY-MM-DD the hotel typed or we derived from one. */
function shiftISO(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** ISO dates compare lexically, so the later of two is just the larger string. */
function laterISO(a: string, b: string | undefined): string {
  return b && b > a ? b : a;
}

/** The first date on or after `iso` whose weekday qualifies. Unconstrained (or
 *  an empty list — see PromoConditions.arrivalDays) returns `iso` unchanged.
 *  At most six steps, so a full week is always covered. */
function nextArrivalDay(iso: string, days: number[] | undefined): string {
  if (!days?.length) return iso;
  for (let i = 0; i < 7; i++) {
    const d = shiftISO(iso, i);
    if (days.includes(dowOf(d))) return d;
  }
  return iso;
}

/**
 * When an offer can be booked, worked out from its conditions and today's date.
 *
 * Returns null when nothing can qualify any more — a stay window that closed, or
 * one whose lead-time rule can no longer be satisfied before it does. Those are
 * dropped from the page rather than shown as expired: a hotel forgetting to
 * delete last summer's early-bird shouldn't put a dead offer in front of guests.
 *
 * Every bound comes from the same fields `offerMatches` reads:
 *   · the stay window fixes the first and last check-in that can ever qualify
 *   · `minNights` pulls the last check-in back — a 3-night minimum inside a
 *     window ending the 30th can't start on the 29th
 *   · `minDaysAhead` pushes the earliest bookable check-in forward from today,
 *     and pulls the booking deadline back from the last check-in
 *   · `maxDaysAhead` caps how far out a check-in can be, which is what makes a
 *     last-minute offer on a Christmas window "not open yet" rather than live
 */
function offerWindow(
  c: PromoConditions | undefined,
  today: string,
): Pick<
  OfferView,
  "earliestCheckin" | "latestCheckin" | "bookBy" | "bookFrom" | "status"
> | null {
  const minAhead = c?.minDaysAhead ?? 0;
  const maxAhead = c?.maxDaysAhead;
  // At least one night, whatever the rules say — a stay is nights, not days.
  const minNights = Math.max(c?.minNights ?? 1, 1);

  const windowFrom = c?.stayFrom;
  // The stay has to END inside the window, so the last check-in is earlier than
  // the window's close by the minimum stay.
  const windowTo = c?.stayTo ? shiftISO(c.stayTo, -minNights) : undefined;

  // Earliest check-in a booking made TODAY could have, and the earliest that
  // also sits inside the stay window. An arrival-day rule then walks it forward
  // to the first weekday that qualifies — otherwise the offer page would open
  // its calendar on a Tuesday for a Thursday-arrivals package.
  const earliestCheckin = nextArrivalDay(
    laterISO(shiftISO(today, minAhead), windowFrom),
    c?.arrivalDays,
  );
  const latestBookableToday = maxAhead == null ? undefined : shiftISO(today, maxAhead);

  // Past the end of the window, and waiting only moves `earliestCheckin` later.
  if (windowTo && earliestCheckin > windowTo) return null;

  const bookBy = windowTo ? shiftISO(windowTo, -minAhead) : undefined;

  // A last-minute rule the window hasn't reached yet: nothing qualifies today,
  // but it will. `windowFrom` is necessarily set here — that's the only way an
  // earliest check-in can land beyond today's last-minute horizon.
  if (latestBookableToday && earliestCheckin > latestBookableToday && windowFrom) {
    return {
      earliestCheckin,
      bookBy,
      bookFrom: shiftISO(windowFrom, -maxAhead!),
      status: "upcoming",
    };
  }

  // The tighter of the two ceilings, and undefined when neither rule caps it —
  // an early bird with no window has no last check-in at all.
  const latestCheckin =
    windowTo && latestBookableToday
      ? (windowTo < latestBookableToday ? windowTo : latestBookableToday)
      : (windowTo ?? latestBookableToday);

  return { earliestCheckin, latestCheckin, bookBy, status: "live" };
}

/**
 * The offers to show on the website, best first.
 *
 * `today` is passed in rather than read from the clock so the server and the
 * browser can't disagree about which offers are live mid-render, and so this
 * stays a pure function.
 */
export function publicOffers(promos: Promotion[], today: string): OfferView[] {
  const out: OfferView[] = [];
  for (const p of promos) {
    if (!isPublishedOffer(p)) continue;
    const conditions = p.trigger === "auto" ? p.conditions : undefined;
    const when = offerWindow(conditions, today);
    if (!when) continue;
    const name = p.name?.trim() || p.code || "";
    out.push({
      id: p.id,
      trigger: p.trigger,
      code: p.trigger === "code" ? p.code : undefined,
      name,
      kind: kindOf(p),
      type: p.type,
      value: p.value,
      inclusions:
        kindOf(p) === "value_add"
          ? p.inclusions?.map((s) => s.trim()).filter(Boolean)
          : undefined,
      // Only present when there's something to say: `{}` would have the renderer
      // print "applies to every stay" and a details list at the same time. An
      // empty weekday array is "any day", so it says nothing either.
      conditions: conditions && Object.values(conditions).some(hasValue) ? conditions : undefined,
      ...when,
    });
  }
  // Bookable now before "opens in December", then the automatic offers (nothing
  // to remember to type), then discounts before value-adds, then the biggest
  // saving. Percent and fixed aren't comparable without a subtotal, so they're
  // only ranked within their own kind.
  //
  // Discounts first is a stated choice, not a side effect of a value-add storing
  // `value: 0`: an inclusion list and a percentage have no common scale, so the
  // tie has to be broken by something, and money is the thing every guest can
  // compare at a glance.
  const rank = (o: OfferView) =>
    (o.status === "live" ? 0 : 1) * 8 +
    (o.trigger === "auto" ? 0 : 1) * 4 +
    (o.kind === "discount" ? 0 : 1) * 2 +
    (o.type === "percent" ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || b.value - a.value);
}

/** A condition worth printing: set, and not an empty weekday list. */
function hasValue(v: unknown): boolean {
  return Array.isArray(v) ? v.length > 0 : v != null;
}
