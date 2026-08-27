// Model Context Protocol surface — the tool definitions and JSON-RPC shaping for
// /mcp, kept pure so they can be reasoned about without a Worker.
//
// The tools are a thin mapping onto the existing /v1 REST endpoints rather than a
// second implementation. The route dispatches each call to the SAME handler the
// REST API uses, in process, which means the two can't drift and anything added
// to a /v1 payload shows up here for free. It also means booking creation — the
// part that touches money and inventory — has exactly one code path.
//
// Tool DESCRIPTIONS matter more than usual: they are the only thing an agent
// reads when deciding what to call, so each says what it's for, what it costs
// (nothing is charged until payment), and what to do next.

/** MCP revisions this server understands. The first is what we advertise. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const SERVER_INFO = { name: "roompanda-booking", version: "1.0.0" } as const;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Where the call is dispatched: the REST method + path template. */
  route: { method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; path: string };
  /** Argument names that go in the query string (GET) rather than the body. */
  query?: string[];
  /** Argument name that fills `:id` in the path. */
  pathParam?: string;
  /** Which key kind this tool is advertised to. Absent = "book". Advertising
   *  only — enforcement lives in each /v1 handler's own key check. */
  scope?: "book" | "manage";
}

const dateStr = { type: "string", description: "YYYY-MM-DD" };

export const TOOLS: McpTool[] = [
  {
    name: "get_property",
    description:
      "Details of the property this key belongs to: name, description, address, currency, check-in and check-out times, and payment and cancellation policy. Call this first — it tells you which currency all prices are in.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    route: { method: "GET", path: "/v1/properties" },
  },
  {
    name: "search_availability",
    description:
      "Bookable rooms and rates for a specific stay, with prices. This is the main tool: use it to answer 'what can I book and what does it cost'. Only rooms that can actually be booked for these dates and this party are returned — a room missing from the results is unavailable, closed, or fails a minimum-stay rule. Prices are in the property's own currency; there is no conversion. Nothing is reserved by calling this.",
    inputSchema: {
      type: "object",
      properties: {
        checkin: { ...dateStr, description: "Arrival date, YYYY-MM-DD" },
        checkout: { ...dateStr, description: "Departure date, YYYY-MM-DD (must be after checkin)" },
        adults: { type: "integer", minimum: 1, default: 2 },
        children_ages: {
          type: "array",
          items: { type: "integer", minimum: 0 },
          description: "One age per child. Ages affect price and whether a child counts as an infant.",
        },
      },
      required: ["checkin", "checkout"],
      additionalProperties: false,
    },
    route: { method: "GET", path: "/v1/availability" },
    query: ["checkin", "checkout", "adults", "children_ages"],
  },
  {
    name: "get_calendar",
    description:
      "Which dates are open or closed over a range, plus minimum-stay rules. Use this when the guest is flexible or hasn't chosen dates, to find candidate stays before pricing them with search_availability.",
    inputSchema: {
      type: "object",
      properties: {
        from: { ...dateStr, description: "First date of the range" },
        to: { ...dateStr, description: "Last date of the range" },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    route: { method: "GET", path: "/v1/calendar" },
    query: ["from", "to"],
  },
  {
    name: "list_rates",
    description:
      "Rate-plan definitions and their policies — meal plan, what's included, whether they're refundable, cancellation deadlines. Use it to explain the difference between rates returned by search_availability.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    route: { method: "GET", path: "/v1/rates" },
  },
  {
    name: "list_extras",
    description:
      "Optional add-ons the guest can buy with a stay (breakfast, transfers, late checkout and so on), with prices and whether each is per room or per booking. Pass the ones the guest wants to create_booking.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    route: { method: "GET", path: "/v1/extras" },
  },
  {
    name: "create_booking",
    description:
      "Create a booking. Prices and availability are re-checked server-side, so a stale quote is rejected rather than silently repriced — call search_availability first and use the exact room_id and rate_id it returned.\n\nIf the rate needs paying, the response is status 'pending_payment' with a payment_url. GIVE THAT URL TO THE GUEST — the booking only becomes confirmed once they have paid on it. Never ask the guest for card details and never try to pay on their behalf. If no payment is due, the booking is confirmed immediately.\n\nPass an idempotency_key to make a retry safe: repeating the same key returns the original result instead of booking twice.\n\nRates that take no card at all — no payment and no guarantee — are limited to one booking an hour, because nothing secures the room. Rates with a deposit or a card guarantee have no such limit. A retry with the same idempotency_key does not count against it.",
    inputSchema: {
      type: "object",
      properties: {
        checkin: { ...dateStr },
        checkout: { ...dateStr },
        rooms: {
          type: "array",
          minItems: 1,
          description: "One entry per room being booked, using ids from search_availability.",
          items: {
            type: "object",
            properties: {
              room_id: { type: "string" },
              rate_id: { type: "string" },
              adults: { type: "integer", minimum: 1 },
              children_ages: { type: "array", items: { type: "integer", minimum: 0 } },
              extras: {
                type: "array",
                description: "Room-scoped add-ons for this room (see list_extras).",
                items: { type: "object" },
              },
            },
            required: ["room_id", "rate_id"],
          },
        },
        // Mirrors the /v1 body schema exactly. Drifting here is worse than
        // useless: a missing `phone` is rejected as a validation error the agent
        // can't predict, and a misnamed notes field is silently dropped.
        guest: {
          type: "object",
          description: "The person staying. Confirm these with the guest before booking.",
          properties: {
            first_name: { type: "string" },
            last_name: { type: "string" },
            email: { type: "string", description: "Where the confirmation is sent" },
            phone: { type: "string", description: "Required by the property" },
            arrival: {
              type: "string",
              description:
                'Expected arrival time (optional) — prefer 24h "HH:MM", e.g. "15:00". Recognisable free text ("3pm", "16h30") is normalized into the PMS arrival-hour field; text saying more than a bare HH:MM is also forwarded to the property\'s PMS as a booking note.',
            },
            requests: {
              type: "string",
              description:
                "Special requests, free text (optional). Forwarded to the property's PMS as a booking note (whitespace collapsed, first 500 characters).",
            },
          },
          required: ["first_name", "last_name", "email", "phone"],
        },
        extras: { type: "array", description: "Booking-scoped add-ons, once for the whole stay.", items: { type: "object" } },
        promo_code: { type: "string" },
        idempotency_key: { type: "string", description: "Any stable string; makes retries safe." },
      },
      required: ["checkin", "checkout", "rooms", "guest"],
      additionalProperties: false,
    },
    route: { method: "POST", path: "/v1/bookings" },
  },
  {
    name: "get_booking",
    description:
      "Look up a booking by its reference or id — status, dates, rooms, totals, and whether payment is still outstanding. Use it after create_booking to check whether the guest has paid.",
    inputSchema: {
      type: "object",
      properties: {
        reference: {
          type: "string",
          description: "The booking reference returned by create_booking (the internal id also works).",
        },
      },
      required: ["reference"],
      additionalProperties: false,
    },
    route: { method: "GET", path: "/v1/bookings/:id" },
    pathParam: "reference",
  },
];

// ── Management tools (ak_ keys) ──────────────────────────────────────────────
// Same thin-mapping principle as the booking tools: each dispatches to the
// /v1/manage handler in process. All of these are READS — the write tools
// arrive with their endpoints, phase by phase. get_ari and the booking tools
// say they are read-only so an agent asked to "close tomorrow" or "cancel this
// booking" explains where that happens instead of hunting for a tool that
// doesn't exist.

const dateQ = (desc: string) => ({ type: "string", description: `${desc}, YYYY-MM-DD` });
const noArgs = { type: "object", properties: {}, additionalProperties: false } as const;

export const MANAGE_TOOLS: McpTool[] = [
  {
    name: "get_property_settings",
    description:
      "The property's configuration: name, slug, currency, languages, pricing mode, facilities, check-in/out times, address, portal (cancellation) policy, plus read-only context — which channel manager it's connected to, whether payments are enabled, website state. Call this first.",
    inputSchema: noArgs,
    route: { method: "GET", path: "/v1/manage/property" },
    scope: "manage",
  },
  {
    name: "get_property_content",
    description:
      "Per-language property text (name, description, address line, phone, email). `values` is what is stored for that language — what an edit would change; `effective` is what a guest reading that language actually sees (missing fields fall back to the default language). Structure and settings live in get_property_settings; this is text only.",
    inputSchema: {
      type: "object",
      properties: { lang: { type: "string", description: "Two-letter language code, e.g. 'de'. Omit for the default language." } },
      additionalProperties: false,
    },
    route: { method: "GET", path: "/v1/manage/property/content" },
    query: ["lang"],
    scope: "manage",
  },
  {
    name: "list_room_types",
    description:
      "The full admin room records: capacities, cleaning fee, facilities, amenity keys, images, ordering, and every language's translations. This is the management view — the guest-facing localized view is a different surface.",
    inputSchema: noArgs,
    route: { method: "GET", path: "/v1/manage/rooms" },
    scope: "manage",
  },
  {
    name: "list_rate_plans",
    description:
      "Full structural rate-plan records, including inactive ones: base price per room, per-occupancy pricing rules, structured payment/cancellation policy, inclusions, and the read-only Channex rate-plan mapping. Date-level prices are NOT here — they are ARI (see get_ari).",
    inputSchema: noArgs,
    route: { method: "GET", path: "/v1/manage/rates" },
    scope: "manage",
  },
  {
    name: "get_tax_config",
    description:
      "The property's tax document: whether prices include tax, the tax and fee rules, and the city-tax configuration.",
    inputSchema: noArgs,
    route: { method: "GET", path: "/v1/manage/taxes" },
    scope: "manage",
  },
  {
    name: "get_extras_catalog",
    description: "Every bookable add-on (active or not) with pricing, options, room/rate exclusions and tax treatment.",
    inputSchema: noArgs,
    route: { method: "GET", path: "/v1/manage/extras" },
    scope: "manage",
  },
  {
    name: "get_promotions",
    description:
      "Promo codes and automatic offers: trigger, discount or value-add, conditions, whether enabled and whether published on the website.",
    inputSchema: noArgs,
    route: { method: "GET", path: "/v1/manage/promotions" },
    scope: "manage",
  },
  {
    name: "list_bookings",
    description:
      "READ-ONLY booking list with filters (status, lifecycle, stay window, created window) and pagination. Bookings cannot be created, cancelled or modified through this API — that happens in the property's channel manager or admin, and if asked to change one, say so.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["confirmed", "simulated", "failed"] },
        lifecycle: { type: "string", enum: ["active", "cancelled"] },
        checkin_from: dateQ("Earliest check-in"),
        checkin_to: dateQ("Latest check-in"),
        created_from: dateQ("Earliest creation date"),
        created_to: dateQ("Latest creation date"),
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    route: { method: "GET", path: "/v1/manage/bookings" },
    query: ["status", "lifecycle", "checkin_from", "checkin_to", "created_from", "created_to", "limit", "offset"],
    scope: "manage",
  },
  {
    name: "get_booking_details",
    description:
      "One booking by id or reference — guest, rooms, totals, taxes snapshot, payment state (never card or gateway internals), cancellation state. READ-ONLY: changes happen in the channel manager or admin.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Booking id or guest-facing reference." } },
      required: ["id"],
      additionalProperties: false,
    },
    route: { method: "GET", path: "/v1/manage/bookings/:id" },
    pathParam: "id",
    scope: "manage",
  },
  {
    name: "get_ari",
    description:
      "READ-ONLY availability/rates/restrictions grid as the booking engine sells it, per date (max 400 days per call): rooms available, nightly prices (major units — zero-decimal currencies come back whole), per-occupancy prices, min-stay and closure flags. Use it to reconcile against another system's inventory. ARI cannot be changed here — updates flow from the property's channel manager; if asked to change availability or prices, say so.",
    inputSchema: {
      type: "object",
      properties: {
        from: dateQ("First date"),
        to: dateQ("Last date"),
        room_id: { type: "string", description: "Optional: only this room type." },
        rate_id: { type: "string", description: "Optional: only this rate plan." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    route: { method: "GET", path: "/v1/manage/ari" },
    query: ["from", "to", "room_id", "rate_id"],
    scope: "manage",
  },
];

// Room/rate write payloads — mirror manage-validate.ts exactly. Omitted fields
// are unchanged; null clears an optional field. Unknown fields are 422s, so a
// drifted schema here shows up as a correctable error, not a silent drop.
const roomBodyProps = {
  title: { type: "string", description: "Room name in the default language." },
  description: { type: ["string", "null"] },
  images: { type: "array", items: { type: "string" }, description: "Our /images/… paths, in display order. Upload first (phase A adds upload endpoints); replacing the list drops removed photos." },
  max_adults: { type: "integer", minimum: 1 },
  max_guests: { type: "integer", minimum: 1, description: "Adults + children this room sleeps; must be ≥ max_adults." },
  cleaning_fee: { type: ["number", "null"], minimum: 0, description: "Once per room per stay; null clears it." },
  facilities: { type: "array", items: { type: "string" }, description: "Free-text lines shown to guests (default language)." },
  amenities: { type: "array", items: { type: "string" }, description: "Google amenity vocabulary keys only — unknown keys are rejected." },
  position: { type: "integer", minimum: 0, description: "Sort position in the rooms list." },
  translations: {
    type: "object",
    description: 'Per-language text overrides, e.g. {"de": {"title": "Doppelzimmer"}}. Never includes the default language — edit the top-level fields for that. Replaces the whole map when present.',
  },
} as const;

const occupancyPricingSchema = {
  type: ["object", "null"],
  description: "Per-person pricing rules; null clears them.",
  properties: {
    default_occupancy: { type: "integer", minimum: 1 },
    extra_adult_price: { type: "number", minimum: 0 },
    less_guest_discount: { type: "number", minimum: 0 },
    child_0_3: { type: "number", minimum: 0 },
    child_4_12: { type: "number", minimum: 0 },
    child_13_plus: { type: "number", minimum: 0 },
    children_as_adults: { type: "boolean" },
  },
} as const;

const ratePolicySchema = {
  type: "object",
  description: "Payment, cancellation and no-show rules. Required on create — there is no implicit default policy.",
  properties: {
    payment: {
      type: "object",
      properties: {
        timing: { type: "string", enum: ["pay_at_hotel", "deposit", "full_prepay"] },
        card: { type: "string", enum: ["guarantee", "charge_at_booking"] },
        deposit: {
          type: "object",
          description: "Required when timing is 'deposit'.",
          properties: { type: { type: "string", enum: ["percent", "fixed", "first_night", "first_n_nights"] }, value: { type: "number", minimum: 0 } },
        },
      },
      required: ["timing", "card"],
    },
    cancellation: {
      type: "object",
      properties: {
        refundable: { type: "boolean" },
        tiers: {
          type: "array",
          description: "Free→penalty windows; empty = free cancellation with no deadline. deadline_value 0 means 'until the anchor time on arrival day'.",
          items: {
            type: "object",
            properties: {
              deadline_value: { type: "integer", minimum: 0 },
              deadline_unit: { type: "string", enum: ["hours", "days"] },
              penalty: { type: "string", enum: ["none", "first_night", "percent", "fixed", "full_stay"] },
              penalty_value: { type: "number", minimum: 0 },
            },
            required: ["deadline_value", "deadline_unit", "penalty"],
          },
        },
      },
      required: ["refundable", "tiers"],
    },
    no_show: {
      type: "object",
      properties: { penalty: { type: "string", enum: ["none", "first_night", "percent", "fixed", "full_stay"] }, penalty_value: { type: "number", minimum: 0 } },
      required: ["penalty"],
    },
    override_note: { type: ["string", "null"], description: "Replaces the auto-generated guest-facing policy text." },
  },
  required: ["payment", "cancellation", "no_show"],
} as const;

const rateBodyProps = {
  title: { type: "string" },
  meal_plan: { type: ["string", "null"] },
  active: { type: "boolean" },
  prices: { type: "object", description: "room_id → base nightly price (> 0). A rate is offered on a room only when it has a price here. NOT date-level ARI prices — those come from the channel manager." },
  occupancy_pricing: occupancyPricingSchema,
  occupancy_pricing_by_room: { type: ["object", "null"], description: "room_id → occupancy-pricing override (same shape as occupancy_pricing)." },
  policy: ratePolicySchema,
  inclusions: { type: "array", items: { type: "string" } },
} as const;

export const MANAGE_WRITE_TOOLS: McpTool[] = [
  {
    name: "update_property_settings",
    description:
      "Edit the property's configuration — sparse: omitted fields stay, null clears. Writable: currency (ISO code), pricing_mode (per_room|per_person), languages (must include the default), single_unit, facilities (curated keys from get_property_settings), checkin_time/checkout_time (HH:MM), timezone (IANA), booking cutoffs, address {city, region, postal_code, country, latitude, longitude}, portal (cancellation/modification policy) and terms/privacy URLs. NOT writable here: connectivity, payments, website domain, live-booking — say so if asked.",
    inputSchema: {
      type: "object",
      properties: {
        currency: { type: "string", description: "ISO 4217 code, e.g. VND. Changes how every price is interpreted — confirm with the operator." },
        pricing_mode: { type: "string", enum: ["per_room", "per_person"] },
        languages: { type: "array", items: { type: "string" }, description: "Guest languages; must include the default language." },
        single_unit: { type: "boolean" },
        facilities: { type: "array", items: { type: "string" }, description: "Curated facility keys only — free-text facilities are per-language content." },
        checkin_time: { type: ["string", "null"], description: '"HH:MM" 24h' },
        checkout_time: { type: ["string", "null"], description: '"HH:MM" 24h' },
        timezone: { type: ["string", "null"], description: "IANA timezone, e.g. Asia/Ho_Chi_Minh" },
        booking_cutoff_days: { type: ["integer", "null"], minimum: 0, maximum: 7 },
        booking_cutoff_time: { type: ["string", "null"] },
        address: { type: "object", description: "{city, region, postal_code, country (ISO-2), latitude, longitude} — each string or null." },
        portal: {
          type: "object",
          description:
            "Guest self-service policy: allow_cancel/allow_modify/auto_refund (booleans), cancel/modify deadline_value (integer ≥ 0; 0 = the anchor time on arrival day) + deadline_unit (hours|days), cancel_anchor_time (HH:MM), after_deadline_message.",
        },
        terms_url: { type: ["string", "null"], description: "https:// URL" },
        privacy_url: { type: ["string", "null"], description: "https:// URL" },
      },
      additionalProperties: false,
    },
    route: { method: "PATCH", path: "/v1/manage/property" },
    scope: "manage",
  },
  {
    name: "update_property_content",
    description:
      "Edit ONE language's property text (hotel_name, property_type, description, address, phone, email). Sparse: omitted fields stay, null clears so the guest sees the default language's text. Pass lang for a translation; omit it to edit the default language — where hotel_name also renames the property. Never copy the default text into a translation to 'fill it in': a cleared field falling back is better than a stale copy.",
    inputSchema: {
      type: "object",
      properties: {
        lang: { type: "string", description: "Two-letter language code; omit for the default language." },
        hotel_name: { type: ["string", "null"] },
        property_type: { type: ["string", "null"] },
        description: { type: ["string", "null"] },
        address: { type: ["string", "null"], description: "Street address line as shown to guests." },
        phone: { type: ["string", "null"] },
        email: { type: ["string", "null"] },
      },
      additionalProperties: false,
    },
    route: { method: "PATCH", path: "/v1/manage/property/content" },
    query: ["lang"],
    scope: "manage",
  },
  {
    name: "set_tax_config",
    description:
      "Replace the property's whole tax document: taxes_inclusive (are taxes inside the room price?), taxes [{name, rate%}], fees [{name, kind: percent|fixed, amount, taxable, basis?}], city_tax ({enabled, name, amount, basis, taxable, children_exempt, max_nights, seasons?} or null). This is a REPLACE — send the full document (read get_tax_config first and modify it). Changing tax mode changes every displayed price; confirm with the operator.",
    inputSchema: {
      type: "object",
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
              basis: { type: "string", enum: ["booking", "room", "room_night", "person", "person_night"], description: "Fixed fees only; omit for once-per-stay." },
            },
            required: ["name", "kind", "amount"],
          },
        },
        city_tax: { type: ["object", "null"] },
      },
      required: ["taxes_inclusive", "taxes", "fees"],
      additionalProperties: false,
    },
    route: { method: "PUT", path: "/v1/manage/taxes" },
    scope: "manage",
  },
  {
    name: "create_room",
    description:
      "Create a room type. Required: title, max_adults, max_guests. It appears at the end of the rooms list. Newly created rooms have no prices — add the room to a rate plan's `prices` (update_rate_plan) or it cannot be sold.",
    inputSchema: { type: "object", properties: roomBodyProps, required: ["title", "max_adults", "max_guests"], additionalProperties: false },
    route: { method: "POST", path: "/v1/manage/rooms" },
    scope: "manage",
  },
  {
    name: "update_room",
    description:
      "Edit a room type. Sparse: omitted fields stay unchanged, null clears an optional field. `translations` replaces the whole map when present — send every language you want kept. Replacing `images` permanently deletes the photos no longer referenced anywhere.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, ...roomBodyProps }, required: ["id"], additionalProperties: false },
    route: { method: "PATCH", path: "/v1/manage/rooms/:id" },
    pathParam: "id",
    scope: "manage",
  },
  {
    name: "delete_room",
    description:
      "Delete a room type. CASCADES: the room's price is removed from every rate plan, and its photos are garbage-collected. Confirm with the operator before deleting a room that has bookings history.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    route: { method: "DELETE", path: "/v1/manage/rooms/:id" },
    pathParam: "id",
    scope: "manage",
  },
  {
    name: "create_rate_plan",
    description:
      "Create a rate plan. Required: title, prices (room_id → base nightly price — the rooms it is sold on), and the full policy (payment, cancellation, no_show). For a Channex-connected property, date-level prices from the channel override these base prices.",
    inputSchema: { type: "object", properties: rateBodyProps, required: ["title", "prices", "policy"], additionalProperties: false },
    route: { method: "POST", path: "/v1/manage/rates" },
    scope: "manage",
  },
  {
    name: "update_rate_plan",
    description:
      "Edit a rate plan. Sparse: omitted fields stay unchanged. `prices` replaces the whole map when present. The Channex mapping (channex_rate_ids) is server-owned and cannot be written.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, ...rateBodyProps }, required: ["id"], additionalProperties: false },
    route: { method: "PATCH", path: "/v1/manage/rates/:id" },
    pathParam: "id",
    scope: "manage",
  },
  {
    name: "delete_rate_plan",
    description: "Delete a rate plan. Existing bookings keep their snapshot; the rate simply stops being offered. Consider `active: false` (update_rate_plan) to pause it instead.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    route: { method: "DELETE", path: "/v1/manage/rates/:id" },
    pathParam: "id",
    scope: "manage",
  },
];

const extraBodyProps = {
  name: { type: "string" },
  description: { type: ["string", "null"] },
  image: { type: ["string", "null"], description: "An /images/… path (REST POST /v1/manage/images uploads one — files can't travel over MCP) or null." },
  unit: { type: "string", enum: ["stay", "night", "person", "person_night", "trip"] },
  price: { type: ["number", "null"], minimum: 0, description: "Simple extras. Omit when `options` price the extra." },
  options: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, price: { type: "number", minimum: 0 }, desc: { type: "string" }, unit: { type: "string", enum: ["stay", "night", "person", "person_night", "trip"] } }, required: ["name", "price"] }, description: "Choices shown in a popup; each may override the unit." },
  fields: { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, short: { type: "string" }, placeholder: { type: "string" }, required: { type: "boolean" } }, required: ["label"] }, description: "Info collected from the guest (e.g. flight number)." },
  info_title: { type: ["string", "null"] },
  scope: { type: "string", enum: ["room", "booking"], description: "room = chosen per room; booking = once for the whole stay." },
  taxable: { type: "boolean", description: "Default true — VAT applies like the room." },
  exclude_rooms: { type: "array", items: { type: "string" } },
  exclude_rates: { type: "array", items: { type: "string" } },
  active: { type: "boolean" },
  position: { type: "integer", minimum: 0 },
} as const;

const promoBodyProps = {
  trigger: { type: "string", enum: ["code", "auto"], description: "code = guest types it at checkout; auto = applies by rules." },
  code: { type: "string", description: "Code promos only — normalized (uppercase, no spaces). Must be unique." },
  name: { type: ["string", "null"], description: "Public label for auto offers (guests see it); internal note for codes." },
  kind: { type: "string", enum: ["discount", "value_add"], description: "value_add = no money off; the inclusions are the offer (value must be 0)." },
  type: { type: "string", enum: ["percent", "fixed"] },
  value: { type: "number", minimum: 0, description: "Percent (1–100) or amount in the property currency. 0 for value-adds." },
  conditions: {
    type: ["object", "null"],
    description:
      "Auto-offer rules, ALL must hold: min_days_ahead (early bird), max_days_ahead (last minute), min_nights, stay_from/stay_to (YYYY-MM-DD), arrival_days/departure_days (weekday numbers, 0=Sunday). Empty day arrays mean any day.",
  },
  inclusions: { type: "array", items: { type: "string" }, description: "Guest-facing 'what you get' lines (required for value-adds)." },
  exclusive: { type: "boolean", description: "Value-adds only: suppress automatic discounts when this applies." },
  enabled: { type: "boolean" },
  published: { type: "boolean", description: "List on the website's offers page." },
} as const;

export const MANAGE_COMMERCE_TOOLS: McpTool[] = [
  {
    name: "create_extra",
    description: "Create a bookable add-on (breakfast, transfer, late checkout…). Required: name, unit. Price it with `price` (simple) or `options` (configurable).",
    inputSchema: { type: "object", properties: extraBodyProps, required: ["name", "unit"], additionalProperties: false },
    route: { method: "POST", path: "/v1/manage/extras" },
    scope: "manage",
  },
  {
    name: "update_extra",
    description: "Edit an add-on. Sparse: omitted fields stay, null clears. `options`/`fields`/exclusion lists replace their whole value when present.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, ...extraBodyProps }, required: ["id"], additionalProperties: false },
    route: { method: "PATCH", path: "/v1/manage/extras/:id" },
    pathParam: "id",
    scope: "manage",
  },
  {
    name: "delete_extra",
    description: "Delete an add-on. Bookings that already include it keep their snapshot.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    route: { method: "DELETE", path: "/v1/manage/extras/:id" },
    pathParam: "id",
    scope: "manage",
  },
  {
    name: "create_promotion",
    description:
      "Create a promo code or automatic offer. Required: trigger. Code promos need a unique code; discounts need type + value > 0; value-adds need inclusions (and value 0); public auto offers need a name. Set published to list it on the website's offers page.",
    inputSchema: { type: "object", properties: promoBodyProps, required: ["trigger"], additionalProperties: false },
    route: { method: "POST", path: "/v1/manage/promotions" },
    scope: "manage",
  },
  {
    name: "update_promotion",
    description: "Edit a promotion. Sparse merge; the cross-field rules (code uniqueness, value-add value 0, public-name requirement) are re-checked on the merged record.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, ...promoBodyProps }, required: ["id"], additionalProperties: false },
    route: { method: "PATCH", path: "/v1/manage/promotions/:id" },
    pathParam: "id",
    scope: "manage",
  },
  {
    name: "delete_promotion",
    description: "Delete a promotion. Bookings that used it keep their snapshot; consider enabled:false to pause it instead.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    route: { method: "DELETE", path: "/v1/manage/promotions/:id" },
    pathParam: "id",
    scope: "manage",
  },
];

const langArg = { lang: { type: "string", description: "Two-letter language code; omit for the default language." } } as const;

export const MANAGE_SITE_TOOLS: McpTool[] = [
  {
    name: "get_site",
    description:
      "The website's state: whether it's enabled (read-only here), the layout style, available styles, and the page list with ids, slugs and default-language titles. Start here for any website task.",
    inputSchema: noArgs,
    route: { method: "GET", path: "/v1/manage/site" },
    scope: "manage",
  },
  {
    name: "set_site_style",
    description: "Switch the website's layout style. Content-safe: pages and text are untouched, so switching back restores exactly what was there.",
    inputSchema: { type: "object", properties: { style: { type: "string", description: "One of the ids get_site lists." } }, required: ["style"], additionalProperties: false },
    route: { method: "PATCH", path: "/v1/manage/site" },
    scope: "manage",
  },
  {
    name: "create_site_page",
    description:
      "Add a website page. Required: slug (URL segment under /p/) and title (written in the default language — every other language falls back to it). Starts with one rich-text section; shape it with set_page_sections and write it with update_page_copy.",
    inputSchema: { type: "object", properties: { slug: { type: "string" }, title: { type: "string" } }, required: ["slug", "title"], additionalProperties: false },
    route: { method: "POST", path: "/v1/manage/site/pages" },
    scope: "manage",
  },
  {
    name: "get_site_page",
    description:
      "One page's structure (sections with ids, types, settings, images) plus ONE language's stored text and the page's valid copy keys. Call this before set_page_sections or update_page_copy — the copy keys and section ids here are the only ones the write endpoints accept.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, ...langArg }, required: ["id"], additionalProperties: false },
    route: { method: "GET", path: "/v1/manage/site/pages/:id" },
    pathParam: "id",
    query: ["lang"],
    scope: "manage",
  },
  {
    name: "update_site_page",
    description: "Change a page's slug or whether it appears in the menu (nav). The home page has neither.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, slug: { type: "string" }, nav: { type: "boolean" } }, required: ["id"], additionalProperties: false },
    route: { method: "PATCH", path: "/v1/manage/site/pages/:id" },
    pathParam: "id",
    scope: "manage",
  },
  {
    name: "delete_site_page",
    description: "Delete a page, its text in EVERY language, and garbage-collect its images. The home page cannot be deleted. Confirm with the operator first.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    route: { method: "DELETE", path: "/v1/manage/site/pages/:id" },
    pathParam: "id",
    scope: "manage",
  },
  {
    name: "set_page_sections",
    description:
      "Replace one page's section STRUCTURE (order, types, visibility, settings, images) — text is untouched and lives in update_page_copy. CRITICAL: reuse the section ids from get_site_page; a regenerated id orphans every language's text for that section. Images must be /images/… paths; dropped ones are permanently garbage-collected.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Page id." },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Keep stable across saves — it keys the translations." },
              type: { type: "string", description: "Section type (get_site_page shows the current ones)." },
              hidden: { type: "boolean" },
              settings: { type: "object", description: "Layout/config only — text fields are rejected here and belong in update_page_copy." },
              images: { type: "array", items: { type: "object", properties: { id: { type: "string" }, url: { type: "string" } }, required: ["url"] } },
            },
            required: ["type"],
          },
        },
      },
      required: ["id", "sections"],
      additionalProperties: false,
    },
    route: { method: "PUT", path: "/v1/manage/site/pages/:id/sections" },
    pathParam: "id",
    scope: "manage",
  },
  {
    name: "update_page_copy",
    description:
      "Edit ONE language's text on one page. Sparse: send only the copy keys you're changing (from get_site_page's copy_keys), null clears a key so it falls back to the default language. Keys not owned by the page are rejected — nothing can write text nowhere renders. Never copy default-language text into a translation to 'fill it in'.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Page id." },
        ...langArg,
        copy: { type: "object", description: "copyKey → text (or null to clear). Keys come from get_site_page." },
      },
      required: ["id", "copy"],
      additionalProperties: false,
    },
    route: { method: "PATCH", path: "/v1/manage/site/pages/:id/copy" },
    pathParam: "id",
    query: ["lang"],
    scope: "manage",
  },
  {
    name: "get_footer",
    description: "The website footer: contact-block toggle, social links, custom links with ONE language's labels, and that language's blurb.",
    inputSchema: { type: "object", properties: { ...langArg }, additionalProperties: false },
    route: { method: "GET", path: "/v1/manage/site/footer" },
    query: ["lang"],
    scope: "manage",
  },
  {
    name: "set_footer",
    description:
      "Edit the footer. Sparse: omitted fields keep their value. `links` REPLACES the link list when present (labels ride each link for the requested language; retained ids keep other languages' labels, removed links lose theirs everywhere). `social` merges per platform (null removes one). Blurb/labels: null clears for this language.",
    inputSchema: {
      type: "object",
      properties: {
        ...langArg,
        show_contact: { type: "boolean" },
        social: { type: "object", description: "platform → https URL, or null to remove that platform." },
        links: { type: "array", items: { type: "object", properties: { id: { type: "string" }, url: { type: "string" }, label: { type: ["string", "null"] } }, required: ["url"] } },
        blurb: { type: ["string", "null"] },
      },
      additionalProperties: false,
    },
    route: { method: "PUT", path: "/v1/manage/site/footer" },
    query: ["lang"],
    scope: "manage",
  },
];

export const MANAGE_CONTENT_TOOLS: McpTool[] = [
  {
    name: "get_gallery",
    description: "The photo gallery: ordered images with ids, plus ONE language's stored alt/caption. Image ids key the per-language text — keep them stable.",
    inputSchema: { type: "object", properties: { ...langArg }, additionalProperties: false },
    route: { method: "GET", path: "/v1/manage/gallery" },
    query: ["lang"],
    scope: "manage",
  },
  {
    name: "set_gallery_images",
    description:
      "Replace the gallery's image LIST in one call — array order is display order. Reuse ids from get_gallery to keep an image and every language's captions; url-only entries are new (upload via the REST images endpoint first); stored images you omit are permanently removed and garbage-collected. Max 40.",
    inputSchema: {
      type: "object",
      properties: { images: { type: "array", items: { type: "object", properties: { id: { type: "string" }, url: { type: "string" } }, required: ["url"] } } },
      required: ["images"],
      additionalProperties: false,
    },
    route: { method: "PUT", path: "/v1/manage/gallery" },
    scope: "manage",
  },
  {
    name: "update_gallery_text",
    description: "Edit alt text / captions for ONE language, sparsely: imageId → { alt?, caption? } (null clears a field; a null entry clears both). Ids come from get_gallery.",
    inputSchema: {
      type: "object",
      properties: { ...langArg, text: { type: "object", description: "imageId → { alt?, caption? } | null" } },
      required: ["text"],
      additionalProperties: false,
    },
    route: { method: "PATCH", path: "/v1/manage/gallery/text" },
    query: ["lang"],
    scope: "manage",
  },
  {
    name: "get_search_content",
    description:
      "The booking page's search/hero block for one language: eyebrow, heading, intro, promo text + placeholder, search button label, highlights, hero image. `values` = stored for that language; `effective` = what guests see after fallback.",
    inputSchema: { type: "object", properties: { ...langArg }, additionalProperties: false },
    route: { method: "GET", path: "/v1/manage/content/search" },
    query: ["lang"],
    scope: "manage",
  },
  {
    name: "update_search_content",
    description:
      "Edit the search/hero block for ONE language, sparsely (null clears → default-language fallback). `highlights` replaces the whole array when present ([{title, description}], usually three). `hero_image` is language-independent — only settable without lang, as an /images/… path or null.",
    inputSchema: {
      type: "object",
      properties: {
        ...langArg,
        eyebrow: { type: ["string", "null"] },
        heading: { type: ["string", "null"] },
        intro: { type: ["string", "null"] },
        promo_text: { type: ["string", "null"] },
        promo_placeholder: { type: ["string", "null"], description: "Example code shown inside the promo input." },
        search_button: { type: ["string", "null"] },
        highlights: { type: ["array", "null"], items: { type: "object", properties: { title: { type: "string" }, description: { type: "string" } }, required: ["title", "description"] } },
        hero_image: { type: ["string", "null"] },
      },
      additionalProperties: false,
    },
    route: { method: "PATCH", path: "/v1/manage/content/search" },
    query: ["lang"],
    scope: "manage",
  },
  {
    name: "get_funnel_page_copy",
    description:
      "One booking-funnel page's editable text (results, detail, checkout, extras, confirmation): its fields with labels, the stored values for one language, and the effective view guests see.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", enum: ["results", "detail", "checkout", "extras", "confirmation"] }, ...langArg },
      required: ["id"],
      additionalProperties: false,
    },
    route: { method: "GET", path: "/v1/manage/content/pages/:id" },
    pathParam: "id",
    query: ["lang"],
    scope: "manage",
  },
  {
    name: "update_funnel_page_copy",
    description: "Edit a funnel page's text for ONE language, sparsely: field → text (null clears → fallback). Valid fields come from get_funnel_page_copy.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", enum: ["results", "detail", "checkout", "extras", "confirmation"] },
        ...langArg,
      },
      required: ["id"],
      additionalProperties: true,
    },
    route: { method: "PATCH", path: "/v1/manage/content/pages/:id" },
    pathParam: "id",
    query: ["lang"],
    scope: "manage",
  },
  {
    name: "get_facility_lines",
    description: "The FREE-TEXT facility lines for one language (curated facility keys are settings — update_property_settings). `effective` shows the whole-list fallback guests see.",
    inputSchema: { type: "object", properties: { ...langArg }, additionalProperties: false },
    route: { method: "GET", path: "/v1/manage/content/facilities" },
    query: ["lang"],
    scope: "manage",
  },
  {
    name: "set_facility_lines",
    description:
      "Replace ONE language's free-text facility lines. Whole-list on purpose (guests fall back list-wise — a half-translated list reads worse than the original); an empty array clears the language.",
    inputSchema: {
      type: "object",
      properties: { ...langArg, lines: { type: "array", items: { type: "string" } } },
      required: ["lines"],
      additionalProperties: false,
    },
    route: { method: "PUT", path: "/v1/manage/content/facilities" },
    query: ["lang"],
    scope: "manage",
  },
];

export const MANAGE_EMAIL_TOOLS: McpTool[] = [
  {
    name: "list_email_templates",
    description:
      "The transactional email templates (booking confirmation, host notification, cancellations, failed booking, review request): each template's editable fields and the {tokens} it may use, plus the current sender identity. There is no send-test tool — sending a real email is a UI action.",
    inputSchema: noArgs,
    route: { method: "GET", path: "/v1/manage/emails" },
    scope: "manage",
  },
  {
    name: "get_email_template",
    description:
      "One email template for one language: `values` = the hotel's stored overrides for that language; `effective` = what actually sends (built-in copy → default-language overrides → this language's). Includes the valid {tokens} — unknown tokens render literally, they never fail a send.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", enum: ["booking_confirmation", "host_notification", "booking_cancellation", "cancellation_notification", "booking_failed", "review_request"] },
        ...langArg,
      },
      required: ["id"],
      additionalProperties: false,
    },
    route: { method: "GET", path: "/v1/manage/emails/:id" },
    pathParam: "id",
    query: ["lang"],
    scope: "manage",
  },
  {
    name: "update_email_template",
    description:
      "Edit one email template's text for ONE language, sparsely: subject/heading/intro/outro → text (null clears → fallback). Use the {tokens} get_email_template lists — e.g. {guest_first_name}, {reference} — and keep them intact when rewording. Changes affect real guest email immediately.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", enum: ["booking_confirmation", "host_notification", "booking_cancellation", "cancellation_notification", "booking_failed", "review_request"] },
        ...langArg,
        subject: { type: ["string", "null"] },
        heading: { type: ["string", "null"] },
        intro: { type: ["string", "null"] },
        outro: { type: ["string", "null"] },
      },
      required: ["id"],
      additionalProperties: false,
    },
    route: { method: "PATCH", path: "/v1/manage/emails/:id" },
    pathParam: "id",
    query: ["lang"],
    scope: "manage",
  },
];

const voucherBodyProps = {
  kind: { type: "string", enum: ["gift", "package", "experience"] },
  title: { type: "string" },
  description: { type: ["string", "null"] },
  image: { type: ["string", "null"], description: "/images/… path or null." },
  price: { type: "number", exclusiveMinimum: 0, description: "Sale price in the property currency." },
  value: { type: ["number", "null"], description: "Gift face value; null = same as price." },
  expires_months: { type: "integer", minimum: 1 },
  cap: { type: ["integer", "null"], minimum: 1, description: "Max sellable; null = unlimited." },
  terms: { type: ["string", "null"] },
  included: { type: "array", items: { type: "string" }, description: "\"What's included\" bullet points." },
  guests: { type: ["integer", "null"], minimum: 1, description: "Experience vouchers: how many people it covers (display only)." },
  active: { type: "boolean" },
  position: { type: "integer", minimum: 0 },
  package: {
    type: ["object", "null"],
    description:
      "Package vouchers only (required for kind 'package'): { nights, adults, children?, room_ids (non-empty), window {from?, to?}, blocked_ranges [{from, to}], checkin_days [0=Sunday…6] }.",
  },
} as const;

export const MANAGE_MISC_TOOLS: McpTool[] = [
  {
    name: "list_voucher_products",
    description:
      "The sellable voucher catalog: gift vouchers, experiences, packages — prices, validity, caps, package rules. SOLD vouchers are money records and are not on this API; refunds and edits to sold vouchers happen in the admin.",
    inputSchema: noArgs,
    route: { method: "GET", path: "/v1/manage/voucher-products" },
    scope: "manage",
  },
  {
    name: "create_voucher_product",
    description:
      "Create a sellable voucher. Required: kind, title, price, expires_months — and package rules when kind is 'package'. Buyers of existing vouchers are never affected by later edits (sold vouchers snapshot the product).",
    inputSchema: { type: "object", properties: voucherBodyProps, required: ["kind", "title", "price", "expires_months"], additionalProperties: false },
    route: { method: "POST", path: "/v1/manage/voucher-products" },
    scope: "manage",
  },
  {
    name: "update_voucher_product",
    description: "Edit a voucher product, sparsely. Already-sold vouchers keep their purchase-time snapshot — price or terms changes only affect future sales.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, ...voucherBodyProps }, required: ["id"], additionalProperties: false },
    route: { method: "PATCH", path: "/v1/manage/voucher-products/:id" },
    pathParam: "id",
    scope: "manage",
  },
  {
    name: "delete_voucher_product",
    description: "Remove a voucher product from sale. Already-sold vouchers stay valid and redeemable.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    route: { method: "DELETE", path: "/v1/manage/voucher-products/:id" },
    pathParam: "id",
    scope: "manage",
  },
  {
    name: "get_brand",
    description: "The theme: preset or custom accent/background colors, the font pairing, and the curated vocabularies (theme presets, font pairing ids). One theme drives the booking pages AND the embeddable widget.",
    inputSchema: noArgs,
    route: { method: "GET", path: "/v1/manage/brand" },
    scope: "manage",
  },
  {
    name: "update_brand",
    description:
      "Change the theme, sparsely: theme (preset id | 'custom' | null), custom_color/custom_bg (#rrggbb hex, null clears), font (a curated pairing id — arbitrary font families are never accepted, nobody has loaded them). Restyles every guest page immediately; confirm with the operator.",
    inputSchema: {
      type: "object",
      properties: {
        theme: { type: ["string", "null"] },
        custom_color: { type: ["string", "null"], description: "#rrggbb" },
        custom_bg: { type: ["string", "null"], description: "#rrggbb" },
        font: { type: ["string", "null"], description: "A font pairing id from get_brand." },
      },
      additionalProperties: false,
    },
    route: { method: "PATCH", path: "/v1/manage/brand" },
    scope: "manage",
  },
  {
    name: "get_brand_kit",
    description:
      "The derived brand kit: an AI copy brief describing the property's look and voice, brand.css, and tokens.json — the same tokens the booking pages use. Start here when building a matching marketing site or any on-brand asset.",
    inputSchema: noArgs,
    route: { method: "GET", path: "/v1/manage/brand-kit" },
    scope: "manage",
  },
  {
    name: "list_reviews",
    description:
      "Guest reviews — the admin view: stars, category ratings, public text, the guest's PRIVATE note to the hotel, and the hotel's response. Reviews cannot be hidden or deleted, by design: a property responds to criticism, it can't bury it.",
    inputSchema: noArgs,
    route: { method: "GET", path: "/v1/manage/reviews" },
    scope: "manage",
  },
  {
    name: "respond_to_review",
    description:
      "Set (or clear, with null) the hotel's PUBLIC reply to one review — shown under the review on the property page. This is the only review write: the guest's text is never editable, and there is no hide or delete. Draft in the property's voice; get the operator's sign-off for sensitive replies.",
    inputSchema: {
      type: "object",
      properties: { booking_id: { type: "string" }, text: { type: ["string", "null"] } },
      required: ["booking_id"],
      additionalProperties: false,
    },
    route: { method: "POST", path: "/v1/manage/reviews/:id/response" },
    pathParam: "booking_id",
    scope: "manage",
  },
];

export const MANAGE_ACCOUNT_TOOLS: McpTool[] = [
  {
    name: "get_team",
    description: "The property's owner and teammates, with the admin areas each teammate can see (operations, pricing, website, emails, payments).",
    inputSchema: noArgs,
    route: { method: "GET", path: "/v1/manage/team" },
    scope: "manage",
  },
  {
    name: "invite_teammate",
    description:
      "Invite one person to this property's admin by email. SENDS A REAL EMAIL to that address (the invite with a sign-in link) — the only management tool that emails anyone. Confirm the address with the operator before calling. New teammates start with full area access; narrow it with set_teammate_areas.",
    inputSchema: { type: "object", properties: { email: { type: "string" } }, required: ["email"], additionalProperties: false },
    route: { method: "POST", path: "/v1/manage/team" },
    scope: "manage",
  },
  {
    name: "set_teammate_areas",
    description: "Set which admin areas a teammate can SEE (send the full list for full access): operations, pricing, website, emails, payments.",
    inputSchema: {
      type: "object",
      properties: { email: { type: "string" }, areas: { type: "array", items: { type: "string", enum: ["operations", "pricing", "website", "emails", "payments"] } } },
      required: ["email", "areas"],
      additionalProperties: false,
    },
    route: { method: "PATCH", path: "/v1/manage/team/:id" },
    pathParam: "email",
    scope: "manage",
  },
  {
    name: "remove_teammate",
    description: "Remove a teammate from THIS property (their account and other properties are untouched). Confirm with the operator first.",
    inputSchema: { type: "object", properties: { email: { type: "string" } }, required: ["email"], additionalProperties: false },
    route: { method: "DELETE", path: "/v1/manage/team/:id" },
    pathParam: "email",
    scope: "manage",
  },
  {
    name: "list_webhooks",
    description: "The property's webhook endpoints (booking.created / booking.cancelled), secrets masked — a secret is shown exactly once, when the endpoint is created.",
    inputSchema: noArgs,
    route: { method: "GET", path: "/v1/manage/webhooks" },
    scope: "manage",
  },
  {
    name: "create_webhook",
    description:
      "Add a webhook endpoint: public https URL + optional event list (empty = all). The response carries the signing secret ONCE — relay it to the operator immediately, it is never shown again. Localhost/internal/private-IP URLs are refused.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, events: { type: "array", items: { type: "string", enum: ["booking.created", "booking.cancelled"] } } },
      required: ["url"],
      additionalProperties: false,
    },
    route: { method: "POST", path: "/v1/manage/webhooks" },
    scope: "manage",
  },
  {
    name: "delete_webhook",
    description: "Remove a webhook endpoint; deliveries stop immediately. There is no update — create a new endpoint (with a fresh secret) instead.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    route: { method: "DELETE", path: "/v1/manage/webhooks/:id" },
    pathParam: "id",
    scope: "manage",
  },
  {
    name: "get_google_settings",
    description: "The direct Google Hotels ARI push: whether it's on, the push window, and the program (hotels / vacation_rentals).",
    inputSchema: noArgs,
    route: { method: "GET", path: "/v1/manage/google" },
    scope: "manage",
  },
  {
    name: "update_google_settings",
    description:
      "Change the Google push. Turning it ON queues a full resync to Google; turning it OFF queues a block (zero inventory + stop-sell) so Google stops selling the property immediately — both are real outbound effects, confirm with the operator. vacation_rentals needs a single-unit property.",
    inputSchema: {
      type: "object",
      properties: {
        push: { type: "boolean" },
        window_days: { type: ["integer", "null"], minimum: 1, maximum: 500 },
        program: { type: "string", enum: ["hotels", "vacation_rentals"] },
      },
      additionalProperties: false,
    },
    route: { method: "PATCH", path: "/v1/manage/google" },
    scope: "manage",
  },
];

const ALL_TOOLS = (): McpTool[] => [
  ...TOOLS,
  ...MANAGE_TOOLS,
  ...MANAGE_WRITE_TOOLS,
  ...MANAGE_COMMERCE_TOOLS,
  ...MANAGE_SITE_TOOLS,
  ...MANAGE_CONTENT_TOOLS,
  ...MANAGE_EMAIL_TOOLS,
  ...MANAGE_MISC_TOOLS,
  ...MANAGE_ACCOUNT_TOOLS,
];

export const toolByName = (name: string): McpTool | undefined => ALL_TOOLS().find((t) => t.name === name);

/** Advertised tool list for a key kind, without the internal routing detail.
 *  Filtering is a courtesy to the agent (a wrong-scope call is refused by the
 *  handler's own key check with a 403 naming the right key kind). */
export const publicToolList = (scope: "book" | "manage" = "book") =>
  ALL_TOOLS()
    .filter((t) => (t.scope ?? "book") === scope)
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

// ── JSON-RPC 2.0 ─────────────────────────────────────────────────────────────

export interface RpcRequest {
  jsonrpc: "2.0";
  /** Absent for notifications, which must NOT be answered. */
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export const rpcResult = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0" as const, id, result });

export const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  error: { code, message },
});

/** A notification carries no id and expects no reply. */
export const isNotification = (req: RpcRequest) => req.id === undefined;

export function negotiateVersion(requested: unknown): string {
  return typeof requested === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : PROTOCOL_VERSION;
}

/** Tool results are content blocks. JSON goes in as text — every MCP client can
 *  read that, whereas richer block types are unevenly supported. */
export const toolContent = (data: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

/** A failed tool call is a RESULT with isError, not a JSON-RPC error: the model
 *  is meant to see the message and correct itself, not have the call vanish. */
export const toolFailure = (message: string) => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/** Builds the query string / body for a tool call from its arguments. */
export function mapArguments(
  tool: McpTool,
  args: Record<string, unknown>,
): { search: URLSearchParams; body?: string; pathValue?: string } {
  const search = new URLSearchParams();
  const pathValue = tool.pathParam ? String(args[tool.pathParam] ?? "") : undefined;
  // Declared query args travel in the URL for every method — a PATCH with
  // ?lang= routes it there, never into the JSON body.
  for (const key of tool.query ?? []) {
    const v = args[key];
    if (v === undefined || v === null || v === "") continue;
    search.set(key, Array.isArray(v) ? v.join(",") : String(v));
  }
  if (tool.route.method === "GET" || tool.route.method === "DELETE") return { search, pathValue };
  // Write bodies pass through, minus the fields the transport handles itself
  // (the idempotency key travels as a header, path/query params in the URL).
  const rest = { ...args };
  delete rest.idempotency_key;
  if (tool.pathParam) delete rest[tool.pathParam];
  for (const key of tool.query ?? []) delete rest[key];
  return { search, body: JSON.stringify(rest), pathValue };
}
