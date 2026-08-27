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
  route: { method: "GET" | "POST"; path: string };
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

const ALL_TOOLS = (): McpTool[] => [...TOOLS, ...MANAGE_TOOLS];

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
  if (tool.route.method === "GET") {
    for (const key of tool.query ?? []) {
      const v = args[key];
      if (v === undefined || v === null || v === "") continue;
      search.set(key, Array.isArray(v) ? v.join(",") : String(v));
    }
    return { search, pathValue: tool.pathParam ? String(args[tool.pathParam] ?? "") : undefined };
  }
  // POST bodies pass through, minus the fields the transport handles itself.
  const { idempotency_key: _ignored, ...rest } = args;
  return { search, body: JSON.stringify(rest) };
}
