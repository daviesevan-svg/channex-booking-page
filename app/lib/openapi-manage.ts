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

const idParam = [{ name: "id", in: "path", required: true, schema: { type: "string" } }];
const baseResponses = {
  "200": { description: "OK" },
  "401": { description: "Missing or invalid key." },
  "403": { description: "Key has the wrong scope — management endpoints need an ak_ key." },
  "404": { description: "No such resource." },
} as const;
const writeOp = (summary: string, description: string, schema: string, isList = false) => ({
  summary,
  description,
  security: manageAuth,
  tags: ["Management"],
  requestBody: {
    required: true,
    content: {
      "application/json": {
        schema: isList ? { type: "array", items: { $ref: `#/components/schemas/${schema}` } } : { $ref: `#/components/schemas/${schema}` },
      },
    },
  },
  responses: { ...baseResponses, "422": { description: "Validation failed — `error.fields` maps each invalid field to its messages. Unknown fields are rejected, not ignored." } },
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
  ManagePropertyPatch: {
    type: "object",
    description: "Sparse settings patch — omitted fields stay, null clears. Unknown fields are 422s.",
    properties: {
      currency: { type: "string", pattern: "^[A-Z]{3}$" },
      pricing_mode: { type: "string", enum: ["per_room", "per_person"] },
      languages: { type: "array", items: { type: "string" }, description: "Must include the default language." },
      single_unit: { type: "boolean" },
      facilities: { type: "array", items: { type: "string" }, description: "Curated facility keys only." },
      checkin_time: { type: ["string", "null"], description: '"HH:MM" 24h.' },
      checkout_time: { type: ["string", "null"] },
      timezone: { type: ["string", "null"], description: "IANA timezone." },
      booking_cutoff_days: { type: ["integer", "null"], minimum: 0, maximum: 7 },
      booking_cutoff_time: { type: ["string", "null"] },
      address: { type: "object", description: "{city, region, postal_code, country (ISO-2), latitude, longitude} — each string or null." },
      portal: { type: "object", description: "Guest self-service policy; deadline_value 0 = the anchor time on arrival day." },
      terms_url: { type: ["string", "null"], description: "https:// URL." },
      privacy_url: { type: ["string", "null"], description: "https:// URL." },
    },
  },
  ManageContentPatch: {
    type: "object",
    description: "Per-language text patch. null clears a field so it falls back to the default language.",
    properties: {
      hotel_name: nullableStr,
      property_type: nullableStr,
      description: nullableStr,
      address: nullableStr,
      phone: nullableStr,
      email: nullableStr,
    },
  },
  ManageTaxDocument: {
    type: "object",
    description: "The full tax document (PUT replaces it wholesale).",
    required: ["taxes_inclusive", "taxes", "fees"],
    properties: {
      taxes_inclusive: { type: "boolean" },
      taxes: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, rate: { type: "number", exclusiveMinimum: 0, maximum: 100 } }, required: ["name", "rate"] } },
      fees: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            kind: { type: "string", enum: ["percent", "fixed"] },
            amount: { type: "number", exclusiveMinimum: 0 },
            taxable: { type: "boolean" },
            basis: { type: "string", enum: ["booking", "room", "room_night", "person", "person_night"] },
          },
          required: ["name", "kind", "amount"],
        },
      },
      city_tax: { type: ["object", "null"], description: "{enabled, name, amount, basis, taxable, children_exempt, max_nights, seasons? (2–3 MM-DD ranges)} or null." },
    },
  },
  ManageRoomInput: {
    type: "object",
    description:
      "Room write payload. PATCH is a sparse merge (omitted = unchanged, null clears); POST requires title, max_adults, max_guests. Unknown fields are 422s. `images` entries must be our /images/… paths; `translations` never includes the default language and replaces the whole map when present.",
    properties: {
      id: { type: "string", description: "PUT-list items only: keep a stable id to preserve createdAt/translations. Ignored on POST." },
      title: { type: "string" },
      description: nullableStr,
      images: { type: "array", items: { type: "string" } },
      max_adults: { type: "integer", minimum: 1 },
      max_guests: { type: "integer", minimum: 1 },
      cleaning_fee: { type: ["number", "null"], minimum: 0 },
      facilities: { type: "array", items: { type: "string" } },
      amenities: { type: "array", items: { type: "string" }, description: "Google amenity vocabulary keys — unknown keys are rejected." },
      position: { type: "integer", minimum: 0 },
      translations: { type: "object" },
    },
  },
  ManageRateInput: {
    type: "object",
    description:
      "Rate-plan write payload. POST requires title, prices and policy (no implicit default policy). `prices` maps room_id → base nightly price > 0 — NOT date-level ARI. `channex_rate_ids` is server-owned and rejected if sent.",
    properties: {
      id: { type: "string", description: "PUT-list items only: keep a stable id to preserve the Channex mapping. Ignored on POST." },
      title: { type: "string" },
      meal_plan: nullableStr,
      active: { type: "boolean" },
      prices: { type: "object", additionalProperties: { type: "number", exclusiveMinimum: 0 } },
      occupancy_pricing: { type: ["object", "null"] },
      occupancy_pricing_by_room: { type: ["object", "null"] },
      policy: {
        type: "object",
        description: "payment {timing, card, deposit?} + cancellation {refundable, tiers[]} + no_show {penalty, penalty_value?} + override_note?. tier.deadline_value 0 = the anchor time on arrival day.",
      },
      inclusions: { type: "array", items: { type: "string" } },
    },
  },
  ManageSiteStylePatch: { type: "object", required: ["style"], properties: { style: { type: "string", description: "One of the ids GET /v1/manage/site lists." } } },
  ManageSitePageCreate: { type: "object", required: ["slug", "title"], properties: { slug: { type: "string" }, title: { type: "string", description: "Written in the default language." } } },
  ManageSitePagePatch: { type: "object", properties: { slug: { type: "string" }, nav: { type: "boolean" } } },
  ManageSiteSections: {
    type: "object",
    description: "A section. Keep `id` stable across saves — it keys the per-language copy.",
    properties: {
      id: { type: "string" },
      type: { type: "string" },
      hidden: { type: "boolean" },
      settings: { type: "object", description: "Non-text config only; text fields belong to the copy endpoint and are rejected here." },
      images: { type: "array", items: { type: "object", properties: { id: { type: "string" }, url: { type: "string" } }, required: ["url"] } },
    },
    required: ["type"],
  },
  ManageSiteCopyPatch: { type: "object", description: "copyKey → text, or null to clear. Valid keys come from the page GET.", additionalProperties: { type: ["string", "null"] } },
  ManageFooterPut: {
    type: "object",
    properties: {
      show_contact: { type: "boolean" },
      social: { type: "object", description: "platform → https URL, null removes the platform." },
      links: { type: "array", items: { type: "object", properties: { id: { type: "string" }, url: { type: "string" }, label: { type: ["string", "null"] } }, required: ["url"] }, description: "Replaces the list when present; max 6." },
      blurb: { type: ["string", "null"] },
    },
  },
  ManageVoucherProductInput: {
    type: "object",
    description: "Voucher product payload. `package` is required for kind 'package' and rejected on other kinds.",
    properties: {
      kind: { type: "string", enum: ["gift", "package", "experience"] },
      title: { type: "string" },
      description: nullableStr,
      image: nullableStr,
      price: { type: "number", exclusiveMinimum: 0 },
      value: { type: ["number", "null"], description: "Gift face value; null = price." },
      expires_months: { type: "integer", minimum: 1 },
      cap: { type: ["integer", "null"], minimum: 1 },
      terms: nullableStr,
      included: { type: "array", items: { type: "string" } },
      guests: { type: ["integer", "null"], minimum: 1 },
      active: { type: "boolean" },
      position: { type: "integer", minimum: 0 },
      package: { type: ["object", "null"], description: "{nights, adults, children?, room_ids, window?, blocked_ranges, checkin_days}." },
    },
  },
  ManageBrandPatch: {
    type: "object",
    properties: {
      theme: { type: ["string", "null"], description: "Preset id, 'custom', or null for default." },
      custom_color: { type: ["string", "null"], description: "#rrggbb" },
      custom_bg: { type: ["string", "null"], description: "#rrggbb" },
      font: { type: ["string", "null"], description: "Curated font-pairing id." },
    },
  },
  ManageEmailPatch: {
    type: "object",
    properties: { subject: nullableStr, heading: nullableStr, intro: nullableStr, outro: nullableStr },
    description: "Use the template's {tokens} (see the GET); they are replaced at send time and unknown ones render literally.",
  },
  ManageGalleryImage: { type: "object", required: ["url"], properties: { id: { type: "string", description: "Keep to preserve the image + its captions." }, url: { type: "string", description: "/images/… path." } } },
  ManageGalleryTextPatch: { type: "object", description: "imageId → { alt?, caption? } | null.", additionalProperties: { type: ["object", "null"] } },
  ManageSearchContentPatch: {
    type: "object",
    properties: {
      eyebrow: nullableStr,
      heading: nullableStr,
      intro: nullableStr,
      promo_text: nullableStr,
      promo_placeholder: nullableStr,
      search_button: nullableStr,
      highlights: { type: ["array", "null"], items: { type: "object", properties: { title: { type: "string" }, description: { type: "string" } }, required: ["title", "description"] } },
      hero_image: { ...nullableStr, description: "/images/… path; language-independent (default language only)." },
    },
  },
  ManageFacilityLines: { type: "string", description: "One facility line." },
  ManageExtraInput: {
    type: "object",
    description: "Add-on write payload. Sparse on PATCH; null clears optionals. `image` must be an /images/… path from POST /v1/manage/images.",
    properties: {
      name: { type: "string" },
      description: nullableStr,
      image: nullableStr,
      unit: { type: "string", enum: ["stay", "night", "person", "person_night", "trip"] },
      price: { type: ["number", "null"], minimum: 0 },
      options: { type: "array", items: { type: "object" } },
      fields: { type: "array", items: { type: "object" } },
      info_title: nullableStr,
      scope: { type: "string", enum: ["room", "booking"] },
      taxable: { type: "boolean" },
      exclude_rooms: { type: "array", items: { type: "string" } },
      exclude_rates: { type: "array", items: { type: "string" } },
      active: { type: "boolean" },
      position: { type: "integer", minimum: 0 },
    },
  },
  ManagePromotionInput: {
    type: "object",
    description: "Promotion write payload. Codes are normalized (uppercase, no whitespace) and must be unique per property.",
    properties: {
      trigger: { type: "string", enum: ["code", "auto"] },
      code: { type: "string" },
      name: nullableStr,
      kind: { type: "string", enum: ["discount", "value_add"] },
      type: { type: "string", enum: ["percent", "fixed"] },
      value: { type: "number", minimum: 0 },
      conditions: { type: ["object", "null"], description: "min_days_ahead, max_days_ahead, min_nights, stay_from/stay_to, arrival_days/departure_days (0=Sunday)." },
      inclusions: { type: "array", items: { type: "string" } },
      exclusive: { type: "boolean" },
      enabled: { type: "boolean" },
      published: { type: "boolean" },
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
  "/v1/manage/property": {
    ...managed(
      "Property settings",
      "The property + settings view: identity, currency, languages, times, address, portal policy, plus read-only connectivity/payments/website state.",
    ),
    patch: writeOp(
      "Edit property settings",
      "Sparse merge over the phase-A allowlist: currency, pricing_mode, languages, single_unit, facilities (curated keys), checkin/checkout_time, timezone, booking cutoffs, address, portal, terms/privacy URLs. null clears a field. connectedSystem, liveBooking, websiteDomain and payment fields are NOT writable.",
      "ManagePropertyPatch",
    ),
  },
  "/v1/manage/property/content": {
    ...managed(
      "Per-language property text",
      "`values` = what is stored for `lang` (what a write edits); `effective` = what a guest reading `lang` sees after default-language fallback.",
      {
        parameters: [
          { name: "lang", in: "query", schema: { type: "string", pattern: "^[a-z]{2}$" }, description: "Two-letter language code; omit for the default language." },
        ],
      },
    ),
    patch: {
      ...writeOp(
        "Edit one language's property text",
        "Sparse: hotel_name, property_type, description, address, phone, email — omitted stays, null clears (falls back to the default language). Editing the default language's hotel_name also renames the property.",
        "ManageContentPatch",
      ),
      parameters: [{ name: "lang", in: "query", schema: { type: "string", pattern: "^[a-z]{2}$" } }],
    },
  },
  "/v1/manage/rooms": {
    ...managed("Room types (admin view)", "Full room records including translations — see ManageRoom."),
    post: writeOp("Create a room", "Required: title, max_adults, max_guests. Appears at the end of the list; add it to a rate plan's prices before it can sell.", "ManageRoomInput"),
    put: writeOp(
      "Replace the room list",
      "Re-import semantics: the array becomes the whole list in one write, order = position, retained ids keep createdAt/translations, dropped rooms' photos are garbage-collected.",
      "ManageRoomInput",
      true,
    ),
  },
  "/v1/manage/rooms/{id}": {
    get: { summary: "One room", security: manageAuth, tags: ["Management"], parameters: idParam, responses: baseResponses },
    patch: { ...writeOp("Edit a room", "Sparse merge: omitted fields unchanged, null clears. `translations` and `images` replace their whole value when present; dropped images are garbage-collected.", "ManageRoomInput"), parameters: idParam },
    delete: {
      summary: "Delete a room",
      description: "CASCADES: the room's price is removed from every rate plan; its photos are garbage-collected.",
      security: manageAuth,
      tags: ["Management"],
      parameters: idParam,
      responses: baseResponses,
    },
  },
  "/v1/manage/rates": {
    ...managed(
      "Rate plans (admin view)",
      "Full structural rate-plan records including inactive ones — see ManageRate. Also returns the property-wide `pricing_mode`.",
    ),
    post: writeOp("Create a rate plan", "Required: title, prices (room_id → base nightly price) and the full policy — there is no implicit default policy.", "ManageRateInput"),
    put: writeOp(
      "Replace the rate-plan list",
      "Re-import semantics. Retained ids keep their server-owned fields (channex_rate_ids, createdAt) — a full replace never severs the Channex mapping.",
      "ManageRateInput",
      true,
    ),
  },
  "/v1/manage/rates/{id}": {
    get: { summary: "One rate plan", security: manageAuth, tags: ["Management"], parameters: idParam, responses: baseResponses },
    patch: { ...writeOp("Edit a rate plan", "Sparse merge. `prices` replaces the whole map when present. channex_rate_ids is read-only.", "ManageRateInput"), parameters: idParam },
    delete: { summary: "Delete a rate plan", description: "Bookings keep their snapshots; consider active:false to pause instead.", security: manageAuth, tags: ["Management"], parameters: idParam, responses: baseResponses },
  },
  "/v1/manage/taxes": {
    ...managed("Tax configuration", "taxes_inclusive, tax rules, fee rules, and the city-tax config as one document."),
    put: writeOp(
      "Replace the tax document",
      "One settings write, so PUT with the full document: taxes_inclusive + taxes[] + fees[] + city_tax (or null). Invalid rows are 422s — the admin form's silent drops are not inherited.",
      "ManageTaxDocument",
    ),
  },
  "/v1/manage/extras": {
    ...managed("Extras catalog (admin view)", "Every add-on, active or not, with options, exclusions and tax treatment."),
    post: writeOp("Create an extra", "Required: name, unit. Price with `price` (simple) or `options` (configurable). taxable defaults true.", "ManageExtraInput"),
  },
  "/v1/manage/extras/{id}": {
    get: { summary: "One extra", security: manageAuth, tags: ["Management"], parameters: idParam, responses: baseResponses },
    patch: { ...writeOp("Edit an extra", "Sparse merge; options/fields/exclusion lists replace wholesale when present; a replaced image is garbage-collected.", "ManageExtraInput"), parameters: idParam },
    delete: { summary: "Delete an extra", description: "Bookings that include it keep their snapshot.", security: manageAuth, tags: ["Management"], parameters: idParam, responses: baseResponses },
  },
  "/v1/manage/promotions": {
    ...managed("Promotions", "Promo codes and automatic offers with their conditions and publish state."),
    post: writeOp(
      "Create a promotion",
      "trigger required. Cross-field rules: code promos need a unique code; discounts need value > 0; value-adds need inclusions and value 0; public auto offers need a name.",
      "ManagePromotionInput",
    ),
  },
  "/v1/manage/promotions/{id}": {
    get: { summary: "One promotion", security: manageAuth, tags: ["Management"], parameters: idParam, responses: baseResponses },
    patch: { ...writeOp("Edit a promotion", "Sparse merge; cross-field rules re-checked on the merged record.", "ManagePromotionInput"), parameters: idParam },
    delete: { summary: "Delete a promotion", description: "Bookings that used it keep their snapshot.", security: manageAuth, tags: ["Management"], parameters: idParam, responses: baseResponses },
  },
  "/v1/manage/site": {
    ...managed("Website state", "Enabled flag (read-only), layout style + available styles, and the page list."),
    patch: writeOp("Switch the layout style", "One field; pages and copy untouched, so switching back restores everything.", "ManageSiteStylePatch"),
  },
  "/v1/manage/site/pages": {
    ...managed("Website pages", "Page summaries with default-language titles."),
    post: writeOp("Create a page", "slug (under /p/) + title (written in the default language). Starts with a rich-text section.", "ManageSitePageCreate"),
  },
  "/v1/manage/site/pages/{id}": {
    get: {
      summary: "One page (structure + one language's text)",
      description: "Sections with stable ids, plus `copy_keys` — the ONLY keys the copy endpoint accepts — and what is stored for `lang` (no fallback).",
      security: manageAuth,
      tags: ["Management"],
      parameters: [...idParam, { name: "lang", in: "query", schema: { type: "string", pattern: "^[a-z]{2}$" } }],
      responses: baseResponses,
    },
    patch: { ...writeOp("Edit slug / nav", "Home has neither.", "ManageSitePagePatch"), parameters: idParam },
    delete: { summary: "Delete a page", description: "Removes its copy in every language and garbage-collects its images.", security: manageAuth, tags: ["Management"], parameters: idParam, responses: baseResponses },
  },
  "/v1/manage/site/pages/{id}/sections": {
    put: {
      ...writeOp(
        "Replace a page's section structure",
        "Text is untouched (it lives on /copy). Keep section ids stable — they key every language's text; a regenerated id orphans the translations. Dropped images are garbage-collected. Accepts the bare array or { sections: [...] }.",
        "ManageSiteSections",
        true,
      ),
      parameters: idParam,
    },
  },
  "/v1/manage/site/pages/{id}/copy": {
    get: {
      summary: "A page's copy keys + one language's stored text",
      security: manageAuth,
      tags: ["Management"],
      parameters: [...idParam, { name: "lang", in: "query", schema: { type: "string", pattern: "^[a-z]{2}$" } }],
      responses: baseResponses,
    },
    patch: {
      ...writeOp(
        "Edit one language's page text",
        "Sparse: copyKey → text, null clears (falls back to the default language). Keys outside the page's copy_keys are 422s. Accepts the bare map or { copy: {...} }.",
        "ManageSiteCopyPatch",
      ),
      parameters: [...idParam, { name: "lang", in: "query", schema: { type: "string", pattern: "^[a-z]{2}$" } }],
    },
  },
  "/v1/manage/site/footer": {
    get: {
      summary: "Footer structure + one language's labels/blurb",
      security: manageAuth,
      tags: ["Management"],
      parameters: [{ name: "lang", in: "query", schema: { type: "string", pattern: "^[a-z]{2}$" } }],
      responses: baseResponses,
    },
    put: {
      ...writeOp(
        "Edit the footer",
        "Sparse over the stored footer. `links` replaces the list when present (labels are per-language; removed links lose labels in every language). `social` merges per platform (null removes). http(s) URLs only.",
        "ManageFooterPut",
      ),
      parameters: [{ name: "lang", in: "query", schema: { type: "string", pattern: "^[a-z]{2}$" } }],
    },
  },
  "/v1/manage/gallery": {
    ...managed("Photo gallery", "Ordered images + one language's stored alt/caption (`?lang=`). Image ids key the per-language text.", {
      parameters: [{ name: "lang", in: "query", schema: { type: "string", pattern: "^[a-z]{2}$" } }],
    }),
    put: writeOp(
      "Replace the image list",
      "Array order = display order (max 40). Entries with a known id keep the image and every language's text; url-only entries are new; omitted stored images are removed and garbage-collected. Accepts the bare array or { images: [...] }.",
      "ManageGalleryImage",
      true,
    ),
  },
  "/v1/manage/gallery/text": {
    patch: {
      ...writeOp("Edit one language's alt/captions", "imageId → { alt?, caption? } (null clears a field; a null entry clears both). Unknown ids are 422s. Accepts the bare map or { text: {...} }.", "ManageGalleryTextPatch"),
      parameters: [{ name: "lang", in: "query", schema: { type: "string", pattern: "^[a-z]{2}$" } }],
    },
  },
  "/v1/manage/content/search": {
    ...managed("Search/hero content", "The booking page's hero block per language: stored `values` + fallback-resolved `effective` + the language-independent hero_image.", {
      parameters: [{ name: "lang", in: "query", schema: { type: "string", pattern: "^[a-z]{2}$" } }],
    }),
    patch: {
      ...writeOp(
        "Edit the search/hero block",
        "Sparse per language; null clears. `highlights` replaces wholesale. `hero_image` (an /images/… path or null) is language-independent and only accepted without a lang override.",
        "ManageSearchContentPatch",
      ),
      parameters: [{ name: "lang", in: "query", schema: { type: "string", pattern: "^[a-z]{2}$" } }],
    },
  },
  "/v1/manage/content/pages/{id}": {
    get: {
      summary: "A booking-funnel page's editable text",
      description: "ids: results, detail, checkout, extras, confirmation. Returns the field definitions, one language's stored values, and the effective view.",
      security: manageAuth,
      tags: ["Management"],
      parameters: [...idParam, { name: "lang", in: "query", schema: { type: "string", pattern: "^[a-z]{2}$" } }],
      responses: baseResponses,
    },
    patch: {
      ...writeOp("Edit a funnel page's text", "Sparse per language: field → text, null clears. Field keys come from the GET.", "ManageSiteCopyPatch"),
      parameters: [...idParam, { name: "lang", in: "query", schema: { type: "string", pattern: "^[a-z]{2}$" } }],
    },
  },
  "/v1/manage/content/facilities": {
    ...managed("Free-text facility lines", "Per language; guests fall back list-wise to the default language. Curated facility keys are settings (PATCH /v1/manage/property).", {
      parameters: [{ name: "lang", in: "query", schema: { type: "string", pattern: "^[a-z]{2}$" } }],
    }),
    put: {
      ...writeOp("Replace one language's facility lines", "Whole-list on purpose; an empty array clears the language. Accepts the bare array or { lines: [...] }.", "ManageFacilityLines", true),
      parameters: [{ name: "lang", in: "query", schema: { type: "string", pattern: "^[a-z]{2}$" } }],
    },
  },
  "/v1/manage/emails": managed(
    "Email template catalog + sender identity",
    "The six transactional templates with their editable fields and valid {tokens}, plus the sender settings (writable via PATCH /v1/manage/property `emails`). No send-test endpoint — a real outbound email is a UI action.",
  ),
  "/v1/manage/emails/{id}": {
    get: {
      summary: "One email template (one language)",
      description: "`values` = stored overrides for `lang`; `effective` = what sends (built-in copy → default language → this language). Unknown {tokens} render literally, never fail a send.",
      security: manageAuth,
      tags: ["Management"],
      parameters: [...idParam, { name: "lang", in: "query", schema: { type: "string", pattern: "^[a-z]{2}$" } }],
      responses: baseResponses,
    },
    patch: {
      ...writeOp("Edit an email template's text", "Sparse per language: subject/heading/intro/outro, null clears → fallback. Changes affect real guest email immediately.", "ManageEmailPatch"),
      parameters: [...idParam, { name: "lang", in: "query", schema: { type: "string", pattern: "^[a-z]{2}$" } }],
    },
  },
  "/v1/manage/voucher-products": {
    ...managed("Voucher catalog", "Sellable gift/experience/package vouchers. SOLD vouchers (money records) are not on the API."),
    post: writeOp("Create a voucher product", "Required: kind, title, price, expires_months; package rules for kind 'package'. Sold vouchers snapshot the product — later edits never affect buyers.", "ManageVoucherProductInput"),
  },
  "/v1/manage/voucher-products/{id}": {
    get: { summary: "One voucher product", security: manageAuth, tags: ["Management"], parameters: idParam, responses: baseResponses },
    patch: { ...writeOp("Edit a voucher product", "Sparse; sold vouchers keep their purchase-time snapshot.", "ManageVoucherProductInput"), parameters: idParam },
    delete: { summary: "Remove from sale", description: "Already-sold vouchers stay valid and redeemable.", security: manageAuth, tags: ["Management"], parameters: idParam, responses: baseResponses },
  },
  "/v1/manage/brand": {
    ...managed("Theme", "Preset or custom colors + curated font pairing, with the valid vocabularies. One theme drives the booking pages and the widget."),
    patch: writeOp("Change the theme", "Sparse: theme (preset id | 'custom' | null), custom_color/custom_bg (#rrggbb | null), font (curated pairing id — arbitrary families are never accepted). Invalid values are 422s, not silently kept.", "ManageBrandPatch"),
  },
  "/v1/manage/brand-kit": managed(
    "Brand kit (derived)",
    "The AI copy brief + brand.css + tokens.json built from the live theme — the same export the admin page offers, for building on-brand assets elsewhere.",
  ),
  "/v1/manage/reviews": managed(
    "Guest reviews (admin view)",
    "Every review including private notes and the hotel's responses. Reviews cannot be hidden or deleted — a property responds to criticism, it can't bury it.",
  ),
  "/v1/manage/reviews/{id}/response": {
    post: {
      summary: "Respond to a review",
      description: "Set (or clear, with null text) the hotel's public reply. The only review write: guest text is never editable; there is no hide or delete.",
      security: manageAuth,
      tags: ["Management"],
      parameters: idParam,
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { text: { type: ["string", "null"] } } } } } },
      responses: baseResponses,
    },
  },
  "/v1/manage/images": {
    post: {
      summary: "Upload an image",
      description:
        "Multipart form data, field `file` (image/*, max 8MB). Returns the /images/… path to reference from any payload. No import-by-URL (SSRF: the only allowlisted importer is Booking.com's CDN, used by onboarding) and no DELETE (an image dies by being unreferenced; the garbage collector owns removal).",
      security: manageAuth,
      tags: ["Management"],
      requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string", format: "binary" } }, required: ["file"] } } } },
      responses: { "201": { description: "Uploaded — body carries data.url." }, "401": baseResponses["401"], "403": baseResponses["403"], "422": { description: "Not an image, too large, or missing." } },
    },
  },
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
