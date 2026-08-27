// Payload validation for the management API's write endpoints.
//
// The admin UI's validators coerce silently (a bad number becomes the minimum,
// an unknown amenity is dropped); an API caller — especially an AI agent —
// can't see a silent drop, so everything here is loud: unknown fields,
// unknown enum values and out-of-range numbers come back as per-field 422
// messages (docs/management-api.md §3). Validators return the CAMEL-case
// domain shape ready for the catalog savers; the wire format is snake_case
// like the read serializers.
import type { CatalogRate, CatalogRoom } from "./catalog.server";
import { VR_AMENITY_KEYS, type DeadlineUnit } from "./content";
import type { OccupancyPricing } from "./rate-pricing";
import type { CancelTier, RatePolicy } from "./rate-policy";

export type Errors = Record<string, string[]>;
export type Validated<T> = { ok: true; value: T } | { ok: false; errors: Errors };

class Ctx {
  errors: Errors = {};
  fail(field: string, msg: string): undefined {
    (this.errors[field] ??= []).push(msg);
    return undefined;
  }
  get failed(): boolean {
    return Object.keys(this.errors).length > 0;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reject unknown top-level fields — a misspelled field silently ignored is
 *  the API-shaped version of the silent drop this module exists to prevent. */
function rejectUnknown(ctx: Ctx, body: Record<string, unknown>, allowed: Set<string>) {
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) ctx.fail(k, "Unknown field.");
  }
}

const optStr = (ctx: Ctx, body: Record<string, unknown>, field: string, opts: { required?: boolean } = {}): string | null | undefined => {
  const v = body[field];
  if (v === undefined) {
    if (opts.required) ctx.fail(field, "Required.");
    return undefined;
  }
  if (v === null) return null;
  if (typeof v !== "string") return ctx.fail(field, "Must be a string.");
  const t = v.trim();
  if (opts.required && !t) return ctx.fail(field, "Must not be empty.");
  return t;
};

const optBool = (ctx: Ctx, body: Record<string, unknown>, field: string): boolean | undefined => {
  const v = body[field];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") return ctx.fail(field, "Must be true or false.");
  return v;
};

const optInt = (ctx: Ctx, body: Record<string, unknown>, field: string, min: number): number | undefined => {
  const v = body[field];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) return ctx.fail(field, `Must be an integer ≥ ${min}.`);
  return v;
};

const optMoney = (ctx: Ctx, obj: Record<string, unknown>, field: string, label = field): number | null | undefined => {
  const v = obj[field];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return ctx.fail(label, "Must be a number ≥ 0.");
  return v;
};

const strList = (ctx: Ctx, body: Record<string, unknown>, field: string): string[] | undefined => {
  const v = body[field];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) return ctx.fail(field, "Must be an array of strings.");
  return (v as string[]).map((s) => s.trim()).filter(Boolean);
};

/** Image references must be our own /images/ paths: external URLs would dodge
 *  upload validation and the GC's referencedBy accounting. */
const imageList = (ctx: Ctx, body: Record<string, unknown>, field: string): string[] | undefined => {
  const list = strList(ctx, body, field);
  if (!list) return list;
  for (const url of list) {
    if (!url.startsWith("/images/")) return ctx.fail(field, `"${url}" is not an /images/… path — upload via POST /v1/manage/images first.`);
  }
  return list;
};

// ── Rooms ────────────────────────────────────────────────────────────────────

const ROOM_FIELDS = new Set(["title", "description", "images", "max_adults", "max_guests", "cleaning_fee", "facilities", "amenities", "position", "translations"]);

export interface RoomInput {
  title?: string;
  description?: string | null;
  images?: string[];
  maxAdults?: number;
  maxGuests?: number;
  cleaningFee?: number | null;
  facilities?: string[];
  amenities?: string[];
  position?: number;
  translations?: CatalogRoom["translations"];
}

export function validateRoomInput(body: unknown, opts: { create: boolean; defaultLang: string }): Validated<RoomInput> {
  const ctx = new Ctx();
  if (!isObj(body)) return { ok: false, errors: { body: ["Must be a JSON object."] } };
  rejectUnknown(ctx, body, ROOM_FIELDS);

  const out: RoomInput = {};
  const title = optStr(ctx, body, "title", { required: opts.create });
  if (typeof title === "string") out.title = title;
  else if (title === null) ctx.fail("title", "Must not be null — every room needs a name.");

  const description = optStr(ctx, body, "description");
  if (description !== undefined) out.description = description || null;

  const images = imageList(ctx, body, "images");
  if (images) out.images = images;

  const maxAdults = optInt(ctx, body, "max_adults", 1);
  if (maxAdults !== undefined) out.maxAdults = maxAdults;
  const maxGuests = optInt(ctx, body, "max_guests", 1);
  if (maxGuests !== undefined) out.maxGuests = maxGuests;
  if (opts.create) {
    if (out.maxAdults === undefined) ctx.fail("max_adults", "Required.");
    if (out.maxGuests === undefined) ctx.fail("max_guests", "Required.");
  }
  if (out.maxAdults !== undefined && out.maxGuests !== undefined && out.maxGuests < out.maxAdults) {
    ctx.fail("max_guests", "Must be ≥ max_adults (guests = adults + children).");
  }

  const fee = optMoney(ctx, body, "cleaning_fee");
  if (fee !== undefined) out.cleaningFee = fee;

  const facilities = strList(ctx, body, "facilities");
  if (facilities) out.facilities = facilities;

  const amenities = strList(ctx, body, "amenities");
  if (amenities) {
    const unknown = amenities.filter((k) => !VR_AMENITY_KEYS.has(k));
    if (unknown.length) ctx.fail("amenities", `Unknown amenity keys: ${unknown.join(", ")}.`);
    else out.amenities = amenities;
  }

  const position = optInt(ctx, body, "position", 0);
  if (position !== undefined) out.position = position;

  const tr = body.translations;
  if (tr !== undefined) {
    if (!isObj(tr)) ctx.fail("translations", "Must be an object keyed by language code.");
    else {
      const map: NonNullable<CatalogRoom["translations"]> = {};
      for (const [lang, entryRaw] of Object.entries(tr)) {
        if (!/^[a-z]{2}$/.test(lang)) {
          ctx.fail("translations", `"${lang}" is not a two-letter language code.`);
          continue;
        }
        if (lang === opts.defaultLang) {
          ctx.fail("translations", `"${lang}" is the default language — edit title/description/facilities directly instead.`);
          continue;
        }
        if (!isObj(entryRaw)) {
          ctx.fail("translations", `"${lang}" must be an object.`);
          continue;
        }
        const sub = new Ctx();
        const t = optStr(sub, entryRaw, "title");
        const d = optStr(sub, entryRaw, "description");
        const f = strList(sub, entryRaw, "facilities");
        if (sub.failed) {
          ctx.fail("translations", `"${lang}": title/description must be strings, facilities an array of strings.`);
          continue;
        }
        const entry = {
          ...(t ? { title: t } : {}),
          ...(d ? { description: d } : {}),
          ...(f?.length ? { facilities: f } : {}),
        };
        if (Object.keys(entry).length) map[lang] = entry;
      }
      out.translations = map;
    }
  }

  return ctx.failed ? { ok: false, errors: ctx.errors } : { ok: true, value: out };
}

// ── Rates ────────────────────────────────────────────────────────────────────

const RATE_FIELDS = new Set(["title", "meal_plan", "active", "prices", "occupancy_pricing", "occupancy_pricing_by_room", "policy", "inclusions"]);
const TIMINGS = new Set(["pay_at_hotel", "deposit", "full_prepay"]);
const CARDS = new Set(["guarantee", "charge_at_booking"]);
const DEPOSITS = new Set(["percent", "fixed", "first_night", "first_n_nights"]);
const PENALTIES = new Set(["none", "first_night", "percent", "fixed", "full_stay"]);
const UNITS = new Set<DeadlineUnit>(["hours", "days"]);

export interface RateInput {
  title?: string;
  mealPlan?: string | null;
  active?: boolean;
  prices?: Record<string, number>;
  occupancyPricing?: OccupancyPricing | null;
  occupancyPricingByRoom?: Record<string, OccupancyPricing> | null;
  policy?: RatePolicy;
  inclusions?: string[];
}

function validateOccupancy(ctx: Ctx, v: unknown, field: string): OccupancyPricing | undefined {
  if (!isObj(v)) return ctx.fail(field, "Must be an object.");
  const allowed = new Set(["default_occupancy", "extra_adult_price", "less_guest_discount", "child_0_3", "child_4_12", "child_13_plus", "children_as_adults"]);
  for (const k of Object.keys(v)) if (!allowed.has(k)) ctx.fail(field, `Unknown field "${k}".`);
  const def = v.default_occupancy;
  if (typeof def !== "number" || !Number.isInteger(def) || def < 1) return ctx.fail(field, "`default_occupancy` must be an integer ≥ 1.");
  const money = (k: string) => {
    const val = optMoney(ctx, v, k, `${field}.${k}`);
    return val === null ? undefined : val;
  };
  const childrenAsAdults = typeof v.children_as_adults === "boolean" ? v.children_as_adults || undefined : undefined;
  if (v.children_as_adults !== undefined && typeof v.children_as_adults !== "boolean") ctx.fail(field, "`children_as_adults` must be a boolean.");
  return {
    defaultOccupancy: def,
    extraAdultPrice: money("extra_adult_price"),
    lessGuestDiscount: money("less_guest_discount"),
    child0to3: money("child_0_3"),
    child4to12: money("child_4_12"),
    child13plus: money("child_13_plus"),
    childrenAsAdults,
  };
}

function validatePolicy(ctx: Ctx, v: unknown): RatePolicy | undefined {
  if (!isObj(v)) return ctx.fail("policy", "Must be an object with payment, cancellation and no_show.");
  const payment = v.payment;
  const cancellation = v.cancellation;
  const noShow = v.no_show;
  if (!isObj(payment)) return ctx.fail("policy", "`payment` is required ({timing, card, deposit?}).");
  if (!isObj(cancellation)) return ctx.fail("policy", "`cancellation` is required ({refundable, tiers}).");
  if (!isObj(noShow)) return ctx.fail("policy", "`no_show` is required ({penalty, penalty_value?}).");

  if (typeof payment.timing !== "string" || !TIMINGS.has(payment.timing)) return ctx.fail("policy", "payment.timing must be pay_at_hotel, deposit or full_prepay.");
  if (typeof payment.card !== "string" || !CARDS.has(payment.card)) return ctx.fail("policy", "payment.card must be guarantee or charge_at_booking.");
  let deposit: RatePolicy["payment"]["deposit"];
  if (payment.deposit !== undefined && payment.deposit !== null) {
    if (!isObj(payment.deposit) || typeof payment.deposit.type !== "string" || !DEPOSITS.has(payment.deposit.type)) {
      return ctx.fail("policy", "payment.deposit.type must be percent, fixed, first_night or first_n_nights.");
    }
    const dv = payment.deposit.value;
    if (typeof dv !== "number" || !Number.isFinite(dv) || dv < 0) return ctx.fail("policy", "payment.deposit.value must be a number ≥ 0.");
    deposit = { type: payment.deposit.type as never, value: dv };
  }
  if (payment.timing === "deposit" && !deposit) return ctx.fail("policy", "payment.deposit is required when timing is deposit.");

  if (typeof cancellation.refundable !== "boolean") return ctx.fail("policy", "cancellation.refundable must be a boolean.");
  if (!Array.isArray(cancellation.tiers)) return ctx.fail("policy", "cancellation.tiers must be an array (empty = free cancellation with no deadline).");
  const tiers: CancelTier[] = [];
  for (const t of cancellation.tiers) {
    if (!isObj(t)) return ctx.fail("policy", "Each cancellation tier must be an object.");
    // A deadline of 0 is meaningful — "until the anchor time on arrival day" —
    // so the check is on type and sign, never truthiness (see PR389).
    if (typeof t.deadline_value !== "number" || !Number.isInteger(t.deadline_value) || t.deadline_value < 0) {
      return ctx.fail("policy", "tier.deadline_value must be an integer ≥ 0 (0 = the anchor time on arrival day).");
    }
    if (typeof t.deadline_unit !== "string" || !UNITS.has(t.deadline_unit as DeadlineUnit)) return ctx.fail("policy", "tier.deadline_unit must be hours or days.");
    if (typeof t.penalty !== "string" || !PENALTIES.has(t.penalty)) return ctx.fail("policy", "tier.penalty must be none, first_night, percent, fixed or full_stay.");
    const pv = t.penalty_value;
    if (pv !== undefined && (typeof pv !== "number" || !Number.isFinite(pv) || pv < 0)) return ctx.fail("policy", "tier.penalty_value must be a number ≥ 0.");
    tiers.push({ deadlineValue: t.deadline_value, deadlineUnit: t.deadline_unit as DeadlineUnit, penalty: t.penalty as never, penaltyValue: pv as number | undefined });
  }
  if (typeof noShow.penalty !== "string" || !PENALTIES.has(noShow.penalty)) return ctx.fail("policy", "no_show.penalty must be none, first_night, percent, fixed or full_stay.");
  const nv = noShow.penalty_value;
  if (nv !== undefined && (typeof nv !== "number" || !Number.isFinite(nv) || nv < 0)) return ctx.fail("policy", "no_show.penalty_value must be a number ≥ 0.");

  const note = v.override_note;
  if (note !== undefined && note !== null && typeof note !== "string") return ctx.fail("policy", "override_note must be a string.");

  return {
    payment: { timing: payment.timing as never, card: payment.card as never, deposit },
    cancellation: { refundable: cancellation.refundable, tiers },
    noShow: { penalty: noShow.penalty as never, penaltyValue: nv as number | undefined },
    overrideNote: typeof note === "string" && note.trim() ? note.trim() : undefined,
  };
}

export function validateRateInput(body: unknown, opts: { create: boolean; roomIds: Set<string> }): Validated<RateInput> {
  const ctx = new Ctx();
  if (!isObj(body)) return { ok: false, errors: { body: ["Must be a JSON object."] } };
  if ("channex_rate_ids" in body) ctx.fail("channex_rate_ids", "Read-only — the Channex mapping is server-owned.");
  rejectUnknown(ctx, body, RATE_FIELDS);

  const out: RateInput = {};
  const title = optStr(ctx, body, "title", { required: opts.create });
  if (typeof title === "string") out.title = title;

  const mealPlan = optStr(ctx, body, "meal_plan");
  if (mealPlan !== undefined) out.mealPlan = mealPlan || null;

  const active = optBool(ctx, body, "active");
  if (active !== undefined) out.active = active;

  const prices = body.prices;
  if (prices !== undefined) {
    if (!isObj(prices)) ctx.fail("prices", "Must be an object of room_id → nightly price.");
    else {
      const map: Record<string, number> = {};
      for (const [roomId, price] of Object.entries(prices)) {
        if (!opts.roomIds.has(roomId)) ctx.fail("prices", `Unknown room id "${roomId}".`);
        else if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) ctx.fail("prices", `Price for "${roomId}" must be a number > 0.`);
        else map[roomId] = price;
      }
      if (!ctx.failed && Object.keys(map).length === 0) ctx.fail("prices", "At least one room price is required — a rate with no prices is offered nowhere.");
      out.prices = map;
    }
  } else if (opts.create) {
    ctx.fail("prices", "Required — the rooms this rate is offered on, with their nightly prices.");
  }

  if (body.occupancy_pricing !== undefined) {
    out.occupancyPricing = body.occupancy_pricing === null ? null : validateOccupancy(ctx, body.occupancy_pricing, "occupancy_pricing") ?? null;
  }
  if (body.occupancy_pricing_by_room !== undefined) {
    const v = body.occupancy_pricing_by_room;
    if (v === null) out.occupancyPricingByRoom = null;
    else if (!isObj(v)) ctx.fail("occupancy_pricing_by_room", "Must be an object of room_id → occupancy pricing.");
    else {
      const map: Record<string, OccupancyPricing> = {};
      for (const [roomId, op] of Object.entries(v)) {
        if (!opts.roomIds.has(roomId)) ctx.fail("occupancy_pricing_by_room", `Unknown room id "${roomId}".`);
        else {
          const parsed = validateOccupancy(ctx, op, `occupancy_pricing_by_room.${roomId}`);
          if (parsed) map[roomId] = parsed;
        }
      }
      out.occupancyPricingByRoom = map;
    }
  }

  if (body.policy !== undefined) {
    const policy = validatePolicy(ctx, body.policy);
    if (policy) out.policy = policy;
  } else if (opts.create) {
    ctx.fail("policy", "Required — payment, cancellation and no_show rules. There is no implicit default policy.");
  }

  const inclusions = strList(ctx, body, "inclusions");
  if (inclusions) out.inclusions = inclusions;

  return ctx.failed ? { ok: false, errors: ctx.errors } : { ok: true, value: out };
}

/** Apply the policy's legacy mirrors exactly as the rate editor does, so the
 *  cancellation engine (which still reads the flat fields) agrees with the
 *  structured policy whichever way a rate was written. */
export function applyPolicyMirrors(rate: CatalogRate, policy: RatePolicy): CatalogRate {
  const tier0 = policy.cancellation.tiers[0];
  return {
    ...rate,
    policy,
    refundable: policy.cancellation.refundable,
    cancelDeadlineValue: tier0?.deadlineValue,
    cancelDeadlineUnit: tier0?.deadlineUnit,
    cancellationNote: policy.overrideNote,
  };
}

/** The standard 422 body. */
export function validationError(errors: Errors): Response {
  return Response.json({ error: { type: "validation_error", message: "The payload has invalid fields.", fields: errors } }, { status: 422 });
}
