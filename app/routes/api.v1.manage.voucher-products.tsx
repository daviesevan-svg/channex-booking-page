import type { Route } from "./+types/api.v1.manage.voucher-products";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { getRooms } from "~/lib/catalog.server";
import type { PackageRules, VoucherProduct } from "~/lib/vouchers";
import { getVoucherProducts, saveVoucherProduct } from "~/lib/vouchers.server";

type Errors = Record<string, string[]>;
const validationError = (errors: Errors) =>
  Response.json({ error: { type: "validation_error", message: "The payload has invalid fields.", fields: errors } }, { status: 422 });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const serializeVoucherProduct = (p: VoucherProduct) => ({
  id: p.id,
  kind: p.kind,
  active: p.active,
  position: p.position,
  title: p.title,
  description: p.description ?? null,
  image: p.image ?? null,
  price: p.price,
  value: p.value ?? null,
  expires_months: p.expiresMonths,
  cap: p.cap ?? null,
  terms: p.terms ?? null,
  included: p.included ?? [],
  guests: p.guests ?? null,
  package: p.package
    ? {
        nights: p.package.nights,
        adults: p.package.adults,
        children: p.package.children ?? 0,
        room_ids: p.package.roomIds,
        window: p.package.window ?? null,
        blocked_ranges: p.package.blockedRanges,
        checkin_days: p.package.checkinDays,
      }
    : null,
  created_at: p.createdAt,
});

export interface VoucherProductInput {
  kind?: VoucherProduct["kind"];
  title?: string;
  description?: string | null;
  image?: string | null;
  price?: number;
  value?: number | null;
  expiresMonths?: number;
  cap?: number | null;
  terms?: string | null;
  included?: string[];
  guests?: number | null;
  active?: boolean;
  position?: number;
  package?: PackageRules | null;
}

export function validateVoucherProduct(body: unknown, opts: { create: boolean; roomIds: Set<string> }): { ok: true; value: VoucherProductInput } | { ok: false; errors: Errors } {
  const errors: Errors = {};
  const fail = (f: string, m: string) => void (errors[f] ??= []).push(m);
  if (!isObj(body)) return { ok: false, errors: { body: ["Must be a JSON object."] } };
  const allowed = new Set(["kind", "title", "description", "image", "price", "value", "expires_months", "cap", "terms", "included", "guests", "active", "position", "package"]);
  for (const k of Object.keys(body)) if (!allowed.has(k)) fail(k, "Unknown field.");

  const out: VoucherProductInput = {};
  if (body.kind !== undefined) {
    if (body.kind !== "gift" && body.kind !== "package" && body.kind !== "experience") fail("kind", "Must be gift, package or experience.");
    else out.kind = body.kind;
  } else if (opts.create) fail("kind", "Required.");

  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) fail("title", "Must be a non-empty string.");
    else out.title = body.title.trim();
  } else if (opts.create) fail("title", "Required.");

  const str = (f: "description" | "terms") => {
    const v = body[f];
    if (v === undefined) return;
    if (v === null) out[f] = null;
    else if (typeof v !== "string") fail(f, "Must be a string or null.");
    else out[f] = v.trim() || null;
  };
  str("description");
  str("terms");

  if (body.image !== undefined) {
    if (body.image === null) out.image = null;
    else if (typeof body.image !== "string" || !body.image.startsWith("/images/")) fail("image", "Must be an /images/… path or null.");
    else out.image = body.image;
  }

  if (body.price !== undefined) {
    if (typeof body.price !== "number" || !(body.price > 0)) fail("price", "Must be a number > 0.");
    else out.price = body.price;
  } else if (opts.create) fail("price", "Required — the sale price in the property currency.");

  if (body.value !== undefined) {
    if (body.value === null) out.value = null;
    else if (typeof body.value !== "number" || !(body.value > 0)) fail("value", "Must be a number > 0 (gift face value) or null (defaults to price).");
    else out.value = body.value;
  }
  if (body.expires_months !== undefined) {
    if (typeof body.expires_months !== "number" || !Number.isInteger(body.expires_months) || body.expires_months < 1) fail("expires_months", "Must be an integer ≥ 1.");
    else out.expiresMonths = body.expires_months;
  } else if (opts.create) fail("expires_months", "Required — validity after purchase, in months.");

  if (body.cap !== undefined) {
    if (body.cap === null) out.cap = null;
    else if (typeof body.cap !== "number" || !Number.isInteger(body.cap) || body.cap < 1) fail("cap", "Must be an integer ≥ 1, or null for unlimited.");
    else out.cap = body.cap;
  }
  if (body.included !== undefined) {
    if (!Array.isArray(body.included) || body.included.some((l) => typeof l !== "string")) fail("included", "Must be an array of strings.");
    else out.included = (body.included as string[]).map((l) => l.trim()).filter(Boolean);
  }
  if (body.guests !== undefined) {
    if (body.guests === null) out.guests = null;
    else if (typeof body.guests !== "number" || !Number.isInteger(body.guests) || body.guests < 1) fail("guests", "Must be an integer ≥ 1 or null.");
    else out.guests = body.guests;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") fail("active", "Must be a boolean.");
    else out.active = body.active;
  }
  if (body.position !== undefined) {
    if (typeof body.position !== "number" || !Number.isInteger(body.position) || body.position < 0) fail("position", "Must be an integer ≥ 0.");
    else out.position = body.position;
  }

  if (body.package !== undefined) {
    if (body.package === null) out.package = null;
    else if (!isObj(body.package)) fail("package", "Must be an object or null.");
    else {
      const p = body.package;
      const pAllowed = new Set(["nights", "adults", "children", "room_ids", "window", "blocked_ranges", "checkin_days"]);
      for (const k of Object.keys(p)) if (!pAllowed.has(k)) fail("package", `Unknown field "${k}".`);
      const int = (f: string, min: number): number | undefined => {
        const v = p[f];
        if (typeof v !== "number" || !Number.isInteger(v) || v < min) return void fail(`package.${f}`, `Must be an integer ≥ ${min}.`);
        return v;
      };
      const nights = int("nights", 1);
      const adults = int("adults", 1);
      const children = p.children === undefined ? 0 : (int("children", 0) ?? 0);
      let roomIds: string[] = [];
      if (!Array.isArray(p.room_ids) || p.room_ids.length === 0 || p.room_ids.some((r) => typeof r !== "string")) {
        fail("package.room_ids", "Must be a non-empty array of room ids.");
      } else {
        roomIds = p.room_ids as string[];
        const unknown = roomIds.filter((r) => !opts.roomIds.has(r));
        if (unknown.length) fail("package.room_ids", `Unknown room ids: ${unknown.join(", ")}.`);
      }
      let window: PackageRules["window"];
      if (p.window !== undefined && p.window !== null) {
        if (!isObj(p.window)) fail("package.window", "Must be { from?, to? } (YYYY-MM-DD) or null.");
        else {
          const from = p.window.from;
          const to = p.window.to;
          if ((from !== undefined && from !== null && (typeof from !== "string" || !DATE.test(from))) || (to !== undefined && to !== null && (typeof to !== "string" || !DATE.test(to)))) {
            fail("package.window", "from/to must be YYYY-MM-DD.");
          } else window = { from: (from as string) || undefined, to: (to as string) || undefined };
        }
      }
      let blockedRanges: PackageRules["blockedRanges"] = [];
      if (p.blocked_ranges !== undefined) {
        if (!Array.isArray(p.blocked_ranges)) fail("package.blocked_ranges", "Must be an array of { from, to }.");
        else {
          for (const r of p.blocked_ranges) {
            if (!isObj(r) || typeof r.from !== "string" || !DATE.test(r.from) || typeof r.to !== "string" || !DATE.test(r.to)) {
              fail("package.blocked_ranges", "Each range needs from/to as YYYY-MM-DD.");
              break;
            }
            blockedRanges.push({ from: r.from, to: r.to });
          }
        }
      }
      let checkinDays: number[] = [];
      if (p.checkin_days !== undefined) {
        if (!Array.isArray(p.checkin_days) || p.checkin_days.some((d) => typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 6)) {
          fail("package.checkin_days", "Must be an array of weekday numbers 0 (Sunday) – 6 (Saturday); empty = any day.");
        } else checkinDays = p.checkin_days as number[];
      }
      if (nights !== undefined && adults !== undefined && !Object.keys(errors).some((k) => k.startsWith("package"))) {
        out.package = { nights, adults, children: children || undefined, roomIds, window, blockedRanges, checkinDays };
      }
    }
  }

  // Cross-field: package products need rules; other kinds must not carry them.
  const kind = out.kind;
  if (kind === "package" && opts.create && !out.package) fail("package", "Required for kind 'package' — nights, adults, room_ids at minimum.");
  if (kind && kind !== "package" && out.package) fail("package", `A ${kind} voucher has no package rules — drop them or set kind to 'package'.`);

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: out };
}

export function buildVoucherProduct(input: VoucherProductInput, base: VoucherProduct): VoucherProduct {
  return {
    ...base,
    kind: input.kind ?? base.kind,
    title: input.title ?? base.title,
    description: input.description === undefined ? base.description : (input.description ?? undefined),
    image: input.image === undefined ? base.image : (input.image ?? undefined),
    price: input.price ?? base.price,
    value: input.value === undefined ? base.value : (input.value ?? undefined),
    expiresMonths: input.expiresMonths ?? base.expiresMonths,
    cap: input.cap === undefined ? base.cap : (input.cap ?? undefined),
    terms: input.terms === undefined ? base.terms : (input.terms ?? undefined),
    included: input.included ?? base.included,
    guests: input.guests === undefined ? base.guests : (input.guests ?? undefined),
    active: input.active ?? base.active,
    position: input.position ?? base.position,
    package: input.package === undefined ? base.package : (input.package ?? undefined),
  };
}

// GET  /v1/manage/voucher-products — the sellable voucher CATALOG (gift,
//      experience, package). Sold vouchers are money records and are not on
//      the API — refunds/edits stay in the admin UI.
// POST — create a product. Editing a product never changes what a buyer
//      already holds: sold vouchers snapshot the product at purchase.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const products = await getVoucherProducts(auth.pid);
  return Response.json({ data: products.map(serializeVoucherProduct) });
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  if (request.method !== "POST") return apiError(405, "method_not_allowed", "Use POST to create.");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }
  const roomIds = new Set((await getRooms(auth.pid)).map((r) => r.id));
  const parsed = validateVoucherProduct(body, { create: true, roomIds });
  if (!parsed.ok) return validationError(parsed.errors);
  const products = await getVoucherProducts(auth.pid);
  const product = buildVoucherProduct(parsed.value, {
    id: crypto.randomUUID(),
    kind: "gift",
    active: parsed.value.active ?? true,
    position: products.length,
    createdAt: new Date().toISOString(),
    title: "",
    price: 0,
    expiresMonths: 12,
  });
  await saveVoucherProduct(auth.pid, product);
  return Response.json({ data: serializeVoucherProduct(product) }, { status: 201 });
}
