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

const ALL_TOOLS = (): McpTool[] => [...TOOLS, ...MANAGE_TOOLS, ...MANAGE_WRITE_TOOLS];

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
