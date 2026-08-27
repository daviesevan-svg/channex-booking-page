// OpenAPI paths + schemas for the management API (/v1/manage/*), merged into
// the served document by api.v1.openapi.tsx. Split from openapi.ts only to
// keep both files reviewable — the SERVED /v1/openapi.json stays the single
// source of truth. Keep in sync with routes/api.v1.manage.*.tsx and
// app/lib/manage-serialize.ts.

const date = { type: "string", format: "date", description: "Calendar date, YYYY-MM-DD." } as const;
const money = { type: "number", minimum: 0, description: "Amount in the property currency, major units." } as const;
const nullableStr = { type: ["string", "null"] } as const;

const manageAuth = [{ ManageKeyAuth: [] as string[] }];
const managed = (summary: string, description: string, extra: Record<string, unknown> = {}) => ({
  get: {
    summary,
    description,
    security: manageAuth,
    tags: ["Management"],
    responses: {
      "200": { description: "OK" },
      "401": { description: "Missing or invalid key." },
      "403": { description: "Key has the wrong scope — management endpoints need an ak_ key." },
    },
    ...extra,
  },
});

export const manageSecuritySchemes = {
  ManageKeyAuth: {
    type: "http",
    scheme: "bearer",
    description:
      "Management API key (`ak_live_…`), issued on the property's API keys page. Disjoint from booking keys: an sk_ key is refused here (403), an ak_ key is refused on the booking endpoints.",
  },
} as const;

export const manageSchemas = {
  ManageRoom: {
    type: "object",
    description: "The admin view of a room type, including every language's translations.",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      description: nullableStr,
      images: { type: "array", items: { type: "string" } },
      max_adults: { type: "integer", minimum: 1 },
      max_guests: { type: "integer", minimum: 1 },
      cleaning_fee: { type: ["number", "null"], minimum: 0 },
      facilities: { type: "array", items: { type: "string" } },
      amenities: { type: "array", items: { type: "string" } },
      position: { type: "integer" },
      translations: { type: "object", description: "Per-language overrides of title/description/facilities." },
      created_at: { type: "string" },
    },
  },
  ManageRate: {
    type: "object",
    description:
      "A structural rate plan. `prices` is the base nightly price per room id — date-level prices are ARI and live on GET /v1/manage/ari. `channex_rate_ids` is read-only server-owned mapping data.",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      meal_plan: nullableStr,
      active: { type: "boolean" },
      prices: { type: "object", additionalProperties: money },
      occupancy_pricing: { type: ["object", "null"] },
      occupancy_pricing_by_room: { type: "object" },
      policy: { type: ["object", "null"], description: "Structured payment/cancellation/no-show policy." },
      inclusions: { type: "array", items: { type: "string" } },
      channex_rate_ids: { type: "object", additionalProperties: { type: "string" }, readOnly: true },
      created_at: { type: "string" },
    },
  },
  ManageBooking: {
    type: "object",
    description:
      "READ-ONLY. Bookings cannot be created, cancelled or modified through the management API — those flows stay on the channel manager and admin. Payment carries no gateway internals.",
    properties: {
      id: { type: "string" },
      reference: { type: "string" },
      channex_id: nullableStr,
      status: { type: "string", enum: ["confirmed", "simulated", "failed"] },
      lifecycle: { type: "string", enum: ["active", "cancelled"] },
      created_at: { type: "string" },
      checkin: date,
      checkout: date,
      nights: { type: "integer", minimum: 1 },
      currency: { type: "string", pattern: "^[A-Z]{3}$" },
      total: money,
      guest: { type: "object" },
      rooms: { type: "array", items: { type: "object" } },
      pricing: { type: ["object", "null"], description: "Taxes & fees snapshot from booking time." },
      payment: { type: ["object", "null"], description: "provider/mode/amount/card summary + refund, never gateway ids." },
      cancelled_at: nullableStr,
      cancelled_by: nullableStr,
    },
  },
} as const;

export const managePaths = {
  "/v1/manage/property": managed(
    "Property settings",
    "The property + settings view: identity, currency, languages, times, address, portal policy, plus read-only connectivity/payments/website state.",
  ),
  "/v1/manage/property/content": managed(
    "Per-language property text",
    "`values` = what is stored for `lang` (what a write edits); `effective` = what a guest reading `lang` sees after default-language fallback.",
    {
      parameters: [
        { name: "lang", in: "query", schema: { type: "string", pattern: "^[a-z]{2}$" }, description: "Two-letter language code; omit for the default language." },
      ],
    },
  ),
  "/v1/manage/rooms": managed("Room types (admin view)", "Full room records including translations — see ManageRoom."),
  "/v1/manage/rates": managed(
    "Rate plans (admin view)",
    "Full structural rate-plan records including inactive ones — see ManageRate. Also returns the property-wide `pricing_mode`.",
  ),
  "/v1/manage/taxes": managed("Tax configuration", "taxes_inclusive, tax rules, fee rules, and the city-tax config as one document."),
  "/v1/manage/extras": managed("Extras catalog (admin view)", "Every add-on, active or not, with options, exclusions and tax treatment."),
  "/v1/manage/promotions": managed("Promotions", "Promo codes and automatic offers with their conditions and publish state."),
  "/v1/manage/bookings": managed(
    "List bookings (read-only)",
    "Newest-created first. Filters: status, lifecycle, checkin_from/checkin_to, created_from/created_to; limit (max 200) + offset. There are no write verbs on bookings — changes flow through the channel manager and admin.",
    {
      parameters: [
        { name: "status", in: "query", schema: { type: "string", enum: ["confirmed", "simulated", "failed"] } },
        { name: "lifecycle", in: "query", schema: { type: "string", enum: ["active", "cancelled"] } },
        { name: "checkin_from", in: "query", schema: date },
        { name: "checkin_to", in: "query", schema: date },
        { name: "created_from", in: "query", schema: date },
        { name: "created_to", in: "query", schema: date },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } },
        { name: "offset", in: "query", schema: { type: "integer", minimum: 0 } },
      ],
    },
  ),
  "/v1/manage/bookings/{id}": managed(
    "One booking (read-only)",
    "By internal id or guest-facing reference — see ManageBooking.",
    { parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] },
  ),
  "/v1/manage/ari": managed(
    "ARI grid (read-only)",
    "Availability, nightly prices (major units — zero-decimal currencies come back whole) with per-occupancy variants, and restrictions, per date. Max 400 days per request. ARI has no write verbs here: it is written only by the property's channel manager (and the admin grid).",
    {
      parameters: [
        { name: "from", in: "query", required: true, schema: date },
        { name: "to", in: "query", required: true, schema: date },
        { name: "room_id", in: "query", schema: { type: "string" } },
        { name: "rate_id", in: "query", schema: { type: "string" } },
      ],
    },
  ),
} as const;
