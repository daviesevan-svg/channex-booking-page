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
import { PROPERTY_FACILITIES, VR_AMENITY_KEYS, isLang, DEFAULT_LANG, type DeadlineUnit, type SiteSettings } from "./content";
import { isSupportedCurrency } from "./currencies";
import { parseHHMM } from "./dates";
import type { Extra, ExtraField, ExtraOption } from "./extras";
import { normalizeCode, type PromoConditions, type Promotion } from "./promotions";
import type { CityTaxConfig, FeeRule, TaxRule } from "./pricing";
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

// ── Property settings (PATCH /v1/manage/property) ───────────────────────────

const PROPERTY_FIELDS = new Set([
  "currency", "pricing_mode", "languages", "single_unit", "facilities",
  "checkin_time", "checkout_time", "timezone", "booking_cutoff_days", "booking_cutoff_time",
  "address", "portal", "terms_url", "privacy_url", "emails",
]);
const FACILITY_KEYS = new Set<string>(PROPERTY_FACILITIES as readonly string[]);

const optHHMM = (ctx: Ctx, obj: Record<string, unknown>, field: string, label = field): string | null | undefined => {
  const v = obj[field];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string" || parseHHMM(v.trim()) == null) return ctx.fail(label, 'Must be "HH:MM" (24h).');
  return v.trim();
};

const optHttpsUrl = (ctx: Ctx, body: Record<string, unknown>, field: string): string | null | undefined => {
  const v = body[field];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") return ctx.fail(field, "Must be a URL string.");
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "https:") return ctx.fail(field, "Must be an https:// URL.");
    return u.toString();
  } catch {
    return ctx.fail(field, "Must be a valid https:// URL.");
  }
};

/** A coordinate value: number or numeric string (stored as string, like the UI). */
const optCoord = (ctx: Ctx, obj: Record<string, unknown>, field: string, label: string, range: number): string | null | undefined => {
  const v = obj[field];
  if (v === undefined) return undefined;
  if (v === null) return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || Math.abs(n) > range) return ctx.fail(label, `Must be a number between -${range} and ${range}.`);
  return String(n);
};

export function validatePropertyPatch(body: unknown): Validated<Partial<SiteSettings>> {
  const ctx = new Ctx();
  if (!isObj(body)) return { ok: false, errors: { body: ["Must be a JSON object."] } };
  rejectUnknown(ctx, body, PROPERTY_FIELDS);
  const out: Partial<SiteSettings> = {};

  const currency = body.currency;
  if (currency !== undefined) {
    if (typeof currency !== "string" || !isSupportedCurrency(currency.trim().toUpperCase())) ctx.fail("currency", "Not a supported ISO 4217 currency code.");
    else out.currency = currency.trim().toUpperCase();
  }
  const mode = body.pricing_mode;
  if (mode !== undefined) {
    if (mode !== "per_room" && mode !== "per_person") ctx.fail("pricing_mode", "Must be per_room or per_person.");
    else out.pricingMode = mode;
  }
  const langs = body.languages;
  if (langs !== undefined) {
    if (!Array.isArray(langs) || langs.some((l) => typeof l !== "string" || !isLang(l))) {
      ctx.fail("languages", "Must be an array of supported language codes.");
    } else if (!langs.includes(DEFAULT_LANG)) {
      ctx.fail("languages", `Must include the default language ("${DEFAULT_LANG}").`);
    } else out.languages = [...new Set(langs as string[])];
  }
  const single = optBool(ctx, body, "single_unit");
  if (single !== undefined) out.singleUnit = single;

  const facilities = strList(ctx, body, "facilities");
  if (facilities) {
    const unknown = facilities.filter((k) => !FACILITY_KEYS.has(k));
    if (unknown.length) ctx.fail("facilities", `Unknown facility keys: ${unknown.join(", ")}. Free-text facilities are per-language content, not settings.`);
    else out.facilities = facilities;
  }

  const checkin = optHHMM(ctx, body, "checkin_time");
  if (checkin !== undefined) out.checkinTime = checkin as never;
  const checkout = optHHMM(ctx, body, "checkout_time");
  if (checkout !== undefined) out.checkoutTime = checkout as never;

  const tz = body.timezone;
  if (tz !== undefined) {
    if (tz === null) out.timezone = null as never;
    else if (typeof tz !== "string") ctx.fail("timezone", "Must be an IANA timezone string.");
    else {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() });
        out.timezone = tz.trim();
      } catch {
        ctx.fail("timezone", `"${tz}" is not a valid IANA timezone.`);
      }
    }
  }
  const cutoffDays = body.booking_cutoff_days;
  if (cutoffDays !== undefined) {
    if (cutoffDays === null) out.bookingCutoffDays = null as never;
    else if (typeof cutoffDays !== "number" || !Number.isInteger(cutoffDays) || cutoffDays < 0 || cutoffDays > 7) ctx.fail("booking_cutoff_days", "Must be an integer 0–7, or null for no limit.");
    else out.bookingCutoffDays = cutoffDays;
  }
  const cutoffTime = optHHMM(ctx, body, "booking_cutoff_time");
  if (cutoffTime !== undefined) out.bookingCutoffTime = cutoffTime as never;

  const address = body.address;
  if (address !== undefined) {
    if (!isObj(address)) ctx.fail("address", "Must be an object.");
    else {
      const allowed = new Set(["city", "region", "postal_code", "country", "latitude", "longitude"]);
      for (const k of Object.keys(address)) if (!allowed.has(k)) ctx.fail("address", `Unknown field "${k}".`);
      const sub = (f: string) => optStr(ctx, address, f);
      const city = sub("city");
      if (city !== undefined) out.addressCity = (city || null) as never;
      const region = sub("region");
      if (region !== undefined) out.addressRegion = (region || null) as never;
      const postal = sub("postal_code");
      if (postal !== undefined) out.addressPostalCode = (postal || null) as never;
      const country = address.country;
      if (country !== undefined) {
        if (country === null) out.addressCountry = null as never;
        else if (typeof country !== "string" || !/^[A-Za-z]{2}$/.test(country.trim())) ctx.fail("address.country", "Must be an ISO 3166-1 alpha-2 code, e.g. GB.");
        else out.addressCountry = country.trim().toUpperCase();
      }
      const lat = optCoord(ctx, address, "latitude", "address.latitude", 90);
      if (lat !== undefined) out.latitude = lat as never;
      const lng = optCoord(ctx, address, "longitude", "address.longitude", 180);
      if (lng !== undefined) out.longitude = lng as never;
    }
  }

  const portal = body.portal;
  if (portal !== undefined) {
    if (!isObj(portal)) ctx.fail("portal", "Must be an object.");
    else {
      const allowed = new Set([
        "allow_cancel", "allow_modify", "auto_refund",
        "cancel_deadline_value", "cancel_deadline_unit", "cancel_anchor_time",
        "modify_deadline_value", "modify_deadline_unit", "after_deadline_message",
      ]);
      for (const k of Object.keys(portal)) if (!allowed.has(k)) ctx.fail("portal", `Unknown field "${k}".`);
      const b = (f: string) => optBool(ctx, portal, f);
      const allowCancel = b("allow_cancel");
      if (allowCancel !== undefined) out.allowCancel = allowCancel;
      const allowModify = b("allow_modify");
      if (allowModify !== undefined) out.allowModify = allowModify;
      const autoRefund = b("auto_refund");
      if (autoRefund !== undefined) out.autoRefund = autoRefund;
      const deadline = (f: string): number | null | undefined => {
        const v = portal[f];
        if (v === undefined) return undefined;
        if (v === null) return null;
        // 0 is meaningful — "until the anchor time on arrival day" (PR389).
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return ctx.fail(`portal.${f}`, "Must be an integer ≥ 0 (0 = the anchor time on arrival day), or null.");
        return v;
      };
      const unit = (f: string): DeadlineUnit | null | undefined => {
        const v = portal[f];
        if (v === undefined) return undefined;
        if (v === null) return null;
        if (v !== "hours" && v !== "days") return ctx.fail(`portal.${f}`, "Must be hours or days.");
        return v;
      };
      const cdv = deadline("cancel_deadline_value");
      if (cdv !== undefined) out.cancelDeadlineValue = cdv as never;
      const cdu = unit("cancel_deadline_unit");
      if (cdu !== undefined) out.cancelDeadlineUnit = cdu as never;
      const anchor = optHHMM(ctx, portal, "cancel_anchor_time", "portal.cancel_anchor_time");
      if (anchor !== undefined) out.cancelAnchorTime = anchor as never;
      const mdv = deadline("modify_deadline_value");
      if (mdv !== undefined) out.modifyDeadlineValue = mdv as never;
      const mdu = unit("modify_deadline_unit");
      if (mdu !== undefined) out.modifyDeadlineUnit = mdu as never;
      const msg = optStr(ctx, portal, "after_deadline_message");
      if (msg !== undefined) out.afterDeadlineMessage = (msg || null) as never;
    }
  }

  const terms = optHttpsUrl(ctx, body, "terms_url");
  if (terms !== undefined) out.termsUrl = terms as never;
  const privacy = optHttpsUrl(ctx, body, "privacy_url");
  if (privacy !== undefined) out.privacyUrl = privacy as never;

  const emails = body.emails;
  if (emails !== undefined) {
    if (!isObj(emails)) ctx.fail("emails", "Must be an object.");
    else {
      const allowed = new Set(["from_name", "reply_to", "host_notify_email", "notify_host_on_booking", "notify_host_on_cancel"]);
      for (const k of Object.keys(emails)) if (!allowed.has(k)) ctx.fail("emails", `Unknown field "${k}".`);
      const fromName = optStr(ctx, emails, "from_name");
      if (fromName !== undefined) out.emailFromName = (fromName || null) as never;
      const emailField = (f: string) => {
        const v = emails[f];
        if (v === undefined) return undefined;
        if (v === null) return null;
        if (typeof v !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim())) return ctx.fail(`emails.${f}`, "Must be an email address or null.");
        return v.trim().toLowerCase();
      };
      const replyTo = emailField("reply_to");
      if (replyTo !== undefined) out.emailReplyTo = replyTo as never;
      const hostNotify = emailField("host_notify_email");
      if (hostNotify !== undefined) out.hostNotifyEmail = hostNotify as never;
      const onBooking = optBool(ctx, emails, "notify_host_on_booking");
      if (onBooking !== undefined) out.notifyHostOnBooking = onBooking;
      const onCancel = optBool(ctx, emails, "notify_host_on_cancel");
      if (onCancel !== undefined) out.notifyHostOnCancel = onCancel;
    }
  }

  if (!ctx.failed && Object.keys(out).length === 0) ctx.fail("body", "No fields to update.");
  return ctx.failed ? { ok: false, errors: ctx.errors } : { ok: true, value: out };
}

// ── Property content (PATCH /v1/manage/property/content) ────────────────────

const CONTENT_FIELDS = ["hotel_name", "property_type", "address", "description", "phone", "email"] as const;
const CONTENT_TO_OVERRIDE: Record<(typeof CONTENT_FIELDS)[number], string> = {
  hotel_name: "hotelName",
  property_type: "propertyType",
  address: "address",
  description: "description",
  phone: "phone",
  email: "email",
};

/** Sparse patch of one language's stored text. Returns override-field keys;
 *  null = clear (fall back to the default language). */
export function validateContentPatch(body: unknown): Validated<Record<string, string | null>> {
  const ctx = new Ctx();
  if (!isObj(body)) return { ok: false, errors: { body: ["Must be a JSON object."] } };
  rejectUnknown(ctx, body, new Set(CONTENT_FIELDS));
  const out: Record<string, string | null> = {};
  for (const f of CONTENT_FIELDS) {
    const v = optStr(ctx, body, f);
    if (v !== undefined) out[CONTENT_TO_OVERRIDE[f]] = v || null;
  }
  if (!ctx.failed && Object.keys(out).length === 0) ctx.fail("body", "No fields to update.");
  return ctx.failed ? { ok: false, errors: ctx.errors } : { ok: true, value: out };
}

// ── Tax document (PUT /v1/manage/taxes) ──────────────────────────────────────

export interface TaxDocument {
  taxesInclusive: boolean;
  taxes: TaxRule[];
  fees: FeeRule[];
  cityTax: CityTaxConfig | null;
}

const FEE_BASES = new Set(["booking", "room", "room_night", "person", "person_night"]);
const CITY_BASES = new Set(["person_night", "room_night", "room_stay"]);
const MMDD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const rid = () => Math.random().toString(36).slice(2, 10);

export function validateTaxDocument(body: unknown): Validated<TaxDocument> {
  const ctx = new Ctx();
  if (!isObj(body)) return { ok: false, errors: { body: ["Must be a JSON object."] } };
  rejectUnknown(ctx, body, new Set(["taxes_inclusive", "taxes", "fees", "city_tax"]));

  const inclusive = optBool(ctx, body, "taxes_inclusive");
  if (inclusive === undefined) ctx.fail("taxes_inclusive", "Required.");

  const taxes: TaxRule[] = [];
  if (!Array.isArray(body.taxes)) ctx.fail("taxes", "Required — an array (possibly empty) of {name, rate}.");
  else {
    for (let i = 0; i < body.taxes.length; i++) {
      const t = body.taxes[i];
      // The UI silently drops a zero-rate row; here it's an error — an agent
      // that sent it meant something by it.
      if (!isObj(t) || typeof t.name !== "string" || !t.name.trim()) ctx.fail(`taxes[${i}]`, "Needs a non-empty name.");
      else if (typeof t.rate !== "number" || !(t.rate > 0) || t.rate > 100) ctx.fail(`taxes[${i}]`, "rate must be a percent > 0 and ≤ 100.");
      else taxes.push({ id: typeof t.id === "string" && t.id.trim() ? t.id.trim() : rid(), name: t.name.trim(), rate: t.rate });
    }
  }

  const fees: FeeRule[] = [];
  if (!Array.isArray(body.fees)) ctx.fail("fees", "Required — an array (possibly empty) of {name, kind, amount, taxable, basis?}.");
  else {
    for (let i = 0; i < body.fees.length; i++) {
      const f = body.fees[i];
      if (!isObj(f) || typeof f.name !== "string" || !f.name.trim()) {
        ctx.fail(`fees[${i}]`, "Needs a non-empty name.");
        continue;
      }
      if (f.kind !== "percent" && f.kind !== "fixed") {
        ctx.fail(`fees[${i}]`, "kind must be percent or fixed.");
        continue;
      }
      if (typeof f.amount !== "number" || !(f.amount > 0)) {
        ctx.fail(`fees[${i}]`, "amount must be a number > 0.");
        continue;
      }
      if (f.basis !== undefined && f.basis !== null) {
        if (typeof f.basis !== "string" || !FEE_BASES.has(f.basis)) {
          ctx.fail(`fees[${i}]`, "basis must be booking, room, room_night, person or person_night.");
          continue;
        }
        if (f.kind !== "fixed" && f.basis !== "booking") {
          ctx.fail(`fees[${i}]`, "basis only applies to fixed fees — percent fees are always % of the room total.");
          continue;
        }
      }
      const basis = f.kind === "fixed" && typeof f.basis === "string" && f.basis !== "booking" ? (f.basis as FeeRule["basis"]) : undefined;
      fees.push({
        id: typeof f.id === "string" && f.id.trim() ? f.id.trim() : rid(),
        name: f.name.trim(),
        kind: f.kind,
        amount: f.amount,
        taxable: f.taxable === true,
        ...(basis ? { basis } : {}),
      });
    }
  }

  let cityTax: CityTaxConfig | null = null;
  const ct = body.city_tax;
  if (ct !== undefined && ct !== null) {
    if (!isObj(ct)) ctx.fail("city_tax", "Must be an object or null.");
    else {
      const allowed = new Set(["enabled", "name", "amount", "basis", "taxable", "children_exempt", "max_nights", "seasons"]);
      for (const k of Object.keys(ct)) if (!allowed.has(k)) ctx.fail("city_tax", `Unknown field "${k}".`);
      if (typeof ct.enabled !== "boolean") ctx.fail("city_tax", "`enabled` (boolean) is required.");
      const amount = typeof ct.amount === "number" && ct.amount >= 0 ? ct.amount : ctx.fail("city_tax", "`amount` must be a number ≥ 0.");
      const basis = typeof ct.basis === "string" && CITY_BASES.has(ct.basis) ? (ct.basis as CityTaxConfig["basis"]) : ctx.fail("city_tax", "`basis` must be person_night, room_night or room_stay.");
      let seasons: CityTaxConfig["seasons"];
      if (ct.seasons !== undefined && ct.seasons !== null) {
        if (!Array.isArray(ct.seasons) || ct.seasons.length < 2 || ct.seasons.length > 3) ctx.fail("city_tax", "`seasons` must have 2–3 entries (one season is just the base amount — omit it).");
        else {
          seasons = [];
          for (let i = 0; i < ct.seasons.length; i++) {
            const s = ct.seasons[i];
            if (!isObj(s) || !MMDD.test(String(s.from)) || !MMDD.test(String(s.to)) || typeof s.amount !== "number" || s.amount < 0) {
              ctx.fail("city_tax", `seasons[${i}] needs "MM-DD" from/to and an amount ≥ 0.`);
            } else seasons.push({ from: String(s.from), to: String(s.to), amount: s.amount });
          }
        }
      }
      const maxNights = ct.max_nights === undefined ? 0 : typeof ct.max_nights === "number" && Number.isInteger(ct.max_nights) && ct.max_nights >= 0 ? ct.max_nights : ctx.fail("city_tax", "`max_nights` must be an integer ≥ 0 (0 = no cap).");
      if (!ctx.failed) {
        cityTax = {
          enabled: ct.enabled === true,
          name: typeof ct.name === "string" && ct.name.trim() ? ct.name.trim() : "City tax",
          amount: amount as number,
          basis: basis as CityTaxConfig["basis"],
          taxable: ct.taxable === true,
          childrenExempt: ct.children_exempt === true,
          maxNights: (maxNights as number) ?? 0,
          ...(seasons && seasons.length >= 2 ? { seasons } : {}),
        };
      }
    }
  }

  return ctx.failed
    ? { ok: false, errors: ctx.errors }
    : { ok: true, value: { taxesInclusive: inclusive as boolean, taxes, fees, cityTax } };
}

// ── Extras ───────────────────────────────────────────────────────────────────

const EXTRA_FIELDS = new Set(["name", "description", "image", "unit", "price", "options", "fields", "info_title", "scope", "taxable", "exclude_rooms", "exclude_rates", "active", "position"]);
const EXTRA_UNITS = new Set(["stay", "night", "person", "person_night", "trip"]);

export interface ExtraInput {
  name?: string;
  desc?: string | null;
  image?: string | null;
  unit?: Extra["unit"];
  price?: number | null;
  options?: ExtraOption[];
  fields?: ExtraField[];
  infoTitle?: string | null;
  scope?: Extra["scope"];
  taxable?: boolean;
  excludeRooms?: string[];
  excludeRates?: string[];
  active?: boolean;
  position?: number;
}

export function validateExtraInput(body: unknown, opts: { create: boolean; roomIds: Set<string>; rateIds: Set<string> }): Validated<ExtraInput> {
  const ctx = new Ctx();
  if (!isObj(body)) return { ok: false, errors: { body: ["Must be a JSON object."] } };
  rejectUnknown(ctx, body, EXTRA_FIELDS);
  const out: ExtraInput = {};

  const name = optStr(ctx, body, "name", { required: opts.create });
  if (typeof name === "string") out.name = name;
  else if (name === null) ctx.fail("name", "Must not be null.");

  const desc = optStr(ctx, body, "description");
  if (desc !== undefined) out.desc = desc || null;
  const infoTitle = optStr(ctx, body, "info_title");
  if (infoTitle !== undefined) out.infoTitle = infoTitle || null;

  const image = body.image;
  if (image !== undefined) {
    if (image === null) out.image = null;
    else if (typeof image !== "string" || !image.startsWith("/images/")) ctx.fail("image", "Must be an /images/… path (upload via POST /v1/manage/images) or null.");
    else out.image = image;
  }

  const unit = body.unit;
  if (unit !== undefined) {
    if (typeof unit !== "string" || !EXTRA_UNITS.has(unit)) ctx.fail("unit", "Must be stay, night, person, person_night or trip.");
    else out.unit = unit as Extra["unit"];
  } else if (opts.create) ctx.fail("unit", "Required.");

  const price = optMoney(ctx, body, "price");
  if (price !== undefined) out.price = price;

  const options = body.options;
  if (options !== undefined) {
    if (!Array.isArray(options)) ctx.fail("options", "Must be an array.");
    else {
      const list: ExtraOption[] = [];
      for (let i = 0; i < options.length; i++) {
        const o = options[i];
        if (!isObj(o) || typeof o.name !== "string" || !o.name.trim()) ctx.fail(`options[${i}]`, "Needs a non-empty name.");
        else if (typeof o.price !== "number" || !Number.isFinite(o.price) || o.price < 0) ctx.fail(`options[${i}]`, "price must be a number ≥ 0.");
        else if (o.unit !== undefined && (typeof o.unit !== "string" || !EXTRA_UNITS.has(o.unit))) ctx.fail(`options[${i}]`, "unit must be stay, night, person, person_night or trip.");
        else {
          list.push({
            id: typeof o.id === "string" && o.id.trim() ? o.id.trim() : rid(),
            name: o.name.trim(),
            price: o.price,
            ...(typeof o.desc === "string" && o.desc.trim() ? { desc: o.desc.trim() } : {}),
            ...(typeof o.unit === "string" ? { unit: o.unit as ExtraOption["unit"] } : {}),
          });
        }
      }
      out.options = list;
    }
  }

  const fields = body.fields;
  if (fields !== undefined) {
    if (!Array.isArray(fields)) ctx.fail("fields", "Must be an array.");
    else {
      const list: ExtraField[] = [];
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        if (!isObj(f) || typeof f.label !== "string" || !f.label.trim()) ctx.fail(`fields[${i}]`, "Needs a non-empty label.");
        else {
          list.push({
            id: typeof f.id === "string" && f.id.trim() ? f.id.trim() : rid(),
            label: f.label.trim(),
            ...(typeof f.short === "string" && f.short.trim() ? { short: f.short.trim() } : {}),
            ...(typeof f.placeholder === "string" && f.placeholder.trim() ? { placeholder: f.placeholder.trim() } : {}),
            required: f.required === true,
          });
        }
      }
      out.fields = list;
    }
  }

  const scope = body.scope;
  if (scope !== undefined) {
    if (scope !== "room" && scope !== "booking") ctx.fail("scope", "Must be room or booking.");
    else out.scope = scope;
  }
  const taxable = optBool(ctx, body, "taxable");
  if (taxable !== undefined) out.taxable = taxable;
  const active = optBool(ctx, body, "active");
  if (active !== undefined) out.active = active;
  const position = optInt(ctx, body, "position", 0);
  if (position !== undefined) out.position = position;

  const exRooms = strList(ctx, body, "exclude_rooms");
  if (exRooms) {
    const unknown = exRooms.filter((id) => !opts.roomIds.has(id));
    if (unknown.length) ctx.fail("exclude_rooms", `Unknown room ids: ${unknown.join(", ")}.`);
    else out.excludeRooms = exRooms;
  }
  const exRates = strList(ctx, body, "exclude_rates");
  if (exRates) {
    const unknown = exRates.filter((id) => !opts.rateIds.has(id));
    if (unknown.length) ctx.fail("exclude_rates", `Unknown rate ids: ${unknown.join(", ")}.`);
    else out.excludeRates = exRates;
  }

  return ctx.failed ? { ok: false, errors: ctx.errors } : { ok: true, value: out };
}

// ── Promotions ───────────────────────────────────────────────────────────────

const PROMO_FIELDS = new Set(["trigger", "code", "name", "kind", "type", "value", "conditions", "inclusions", "exclusive", "enabled", "published"]);

export interface PromotionInput {
  trigger?: Promotion["trigger"];
  code?: string;
  name?: string | null;
  kind?: Promotion["kind"];
  type?: Promotion["type"];
  value?: number;
  conditions?: PromoConditions | null;
  inclusions?: string[];
  exclusive?: boolean;
  enabled?: boolean;
  publish?: boolean;
}

export function validatePromotionInput(body: unknown, opts: { create: boolean }): Validated<PromotionInput> {
  const ctx = new Ctx();
  if (!isObj(body)) return { ok: false, errors: { body: ["Must be a JSON object."] } };
  rejectUnknown(ctx, body, PROMO_FIELDS);
  const out: PromotionInput = {};

  const trigger = body.trigger;
  if (trigger !== undefined) {
    if (trigger !== "code" && trigger !== "auto") ctx.fail("trigger", "Must be code or auto.");
    else out.trigger = trigger;
  } else if (opts.create) ctx.fail("trigger", "Required — code (guest enters it) or auto (applies by rules).");

  const code = body.code;
  if (code !== undefined) {
    if (typeof code !== "string") ctx.fail("code", "Must be a string.");
    else out.code = normalizeCode(code);
  }

  const name = optStr(ctx, body, "name");
  if (name !== undefined) out.name = name || null;

  const kind = body.kind;
  if (kind !== undefined) {
    if (kind !== "discount" && kind !== "value_add") ctx.fail("kind", "Must be discount or value_add.");
    else out.kind = kind;
  }
  const type = body.type;
  if (type !== undefined) {
    if (type !== "percent" && type !== "fixed") ctx.fail("type", "Must be percent or fixed.");
    else out.type = type;
  }
  const value = body.value;
  if (value !== undefined) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) ctx.fail("value", "Must be a number ≥ 0.");
    else out.value = value;
  }

  const conditions = body.conditions;
  if (conditions !== undefined) {
    if (conditions === null) out.conditions = null;
    else if (!isObj(conditions)) ctx.fail("conditions", "Must be an object or null.");
    else {
      const allowed = new Set(["min_days_ahead", "max_days_ahead", "min_nights", "stay_from", "stay_to", "arrival_days", "departure_days"]);
      for (const k of Object.keys(conditions)) if (!allowed.has(k)) ctx.fail("conditions", `Unknown field "${k}".`);
      const intField = (f: string, min: number) => {
        const v = conditions[f];
        if (v === undefined || v === null) return undefined;
        if (typeof v !== "number" || !Number.isInteger(v) || v < min) return ctx.fail(`conditions.${f}`, `Must be an integer ≥ ${min}.`);
        return v;
      };
      const dateField = (f: string) => {
        const v = conditions[f];
        if (v === undefined || v === null) return undefined;
        if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return ctx.fail(`conditions.${f}`, "Must be YYYY-MM-DD.");
        return v;
      };
      const daysField = (f: string) => {
        const v = conditions[f];
        if (v === undefined || v === null) return undefined;
        if (!Array.isArray(v) || v.some((d) => typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 6)) {
          return ctx.fail(`conditions.${f}`, "Must be an array of weekday numbers 0 (Sunday) – 6 (Saturday).");
        }
        return v as number[];
      };
      out.conditions = {
        minDaysAhead: intField("min_days_ahead", 0),
        maxDaysAhead: intField("max_days_ahead", 0),
        minNights: intField("min_nights", 1),
        stayFrom: dateField("stay_from"),
        stayTo: dateField("stay_to"),
        arrivalDays: daysField("arrival_days"),
        departureDays: daysField("departure_days"),
      };
    }
  }

  const inclusions = strList(ctx, body, "inclusions");
  if (inclusions) out.inclusions = inclusions;
  const exclusive = optBool(ctx, body, "exclusive");
  if (exclusive !== undefined) out.exclusive = exclusive;
  const enabled = optBool(ctx, body, "enabled");
  if (enabled !== undefined) out.enabled = enabled;
  const published = optBool(ctx, body, "published");
  if (published !== undefined) out.publish = published;

  return ctx.failed ? { ok: false, errors: ctx.errors } : { ok: true, value: out };
}

/** Cross-field promo rules, checked on the MERGED record (a sparse PATCH may
 *  change only one side of a pair). Returns errors or null. */
export function promotionCrossFieldErrors(p: Promotion): Errors | null {
  const errors: Errors = {};
  if (p.trigger === "code" && !p.code) errors.code = ["A code promotion needs a code."];
  if (p.trigger === "auto" && p.code) errors.code = ["An automatic offer has no code — set trigger to 'code' or drop it."];
  const kind = p.kind ?? "discount";
  if (kind === "discount" && !(p.value > 0)) errors.value = ["A discount needs a value > 0."];
  if (kind === "value_add" && p.value !== 0) errors.value = ["A value-add stores value 0 — the inclusions ARE the offer."];
  if (kind === "value_add" && !(p.inclusions ?? []).length) errors.inclusions = ["A value-add needs at least one inclusion line."];
  if (p.trigger === "auto" && kind === "discount" && !(p.name ?? "").trim()) errors.name = ["An automatic offer needs a public name (it is shown to guests)."];
  return Object.keys(errors).length ? errors : null;
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
