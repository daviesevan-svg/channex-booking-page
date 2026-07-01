// OpenAPI 3.1 description of the public /v1 API — the single source of truth,
// served at GET /v1/openapi.json. Keep in sync with the routes in
// app/routes/api.v1.*.tsx and the shapes in app/lib/api-serialize.ts. Constraints
// (uuid formats, integer bounds, currency pattern) mirror the server validation
// in api.v1.bookings.tsx so the schema is precise, not merely structural.

// ---- reusable field fragments ----
/** All resource ids (property, room, rate, extra, booking) are v4 UUIDs. */
const uuid = { type: "string", format: "uuid" } as const;
const uuidNullable = { type: ["string", "null"], format: "uuid" } as const;
/** ISO 4217 three-letter currency code, e.g. "GBP". */
const currency = { type: "string", pattern: "^[A-Z]{3}$", description: "ISO 4217 currency code, e.g. GBP." } as const;
const currencyNullable = { type: ["string", "null"], pattern: "^[A-Z]{3}$", description: "ISO 4217 currency code, e.g. GBP." } as const;
/** A monetary amount in the property currency; never negative. */
const money = { type: "number", minimum: 0 } as const;
const moneyNullable = { type: ["number", "null"], minimum: 0 } as const;
const date = { type: "string", format: "date", description: "Calendar date, YYYY-MM-DD." } as const;
/** A gross price for the whole stay, serialised as a decimal string, e.g. "240.00". */
const priceString = { type: "string", pattern: "^\\d+(\\.\\d{1,2})?$", description: "Decimal amount as a string, e.g. \"240.00\"." } as const;

const ratePlan = {
  type: "object",
  properties: {
    id: uuid,
    parent_rate_id: uuidNullable,
    title: { type: "string" },
    meal_plan: { type: ["string", "null"] },
    currency: currencyNullable,
    total_price: { ...priceString, description: "Gross price for the whole stay." },
    available: { type: ["integer", "null"], minimum: 0, description: "Rooms left to sell at this rate." },
    occupancy: {
      type: "object",
      properties: {
        adults: { type: "integer", minimum: 1 },
        children: { type: "integer", minimum: 0 },
        infants: { type: "integer", minimum: 0 },
      },
    },
    refundable: { type: ["boolean", "null"] },
    free_cancel_until: { type: ["string", "null"], format: "date-time", description: "ISO 8601 deadline for free cancellation." },
    description: { type: ["string", "null"] },
    inclusions: { type: "array", items: { type: "string" } },
    offer: {
      type: ["object", "null"],
      properties: {
        name: { type: "string" },
        percent: { type: "number", minimum: 0, maximum: 100 },
        original_total_price: priceString,
      },
    },
  },
} as const;

const booking = {
  type: "object",
  properties: {
    id: uuid,
    reference: { type: "string", minLength: 8, maxLength: 8, pattern: "^[0-9A-HJKMNP-TV-Z]{8}$", description: "The guest-facing booking reference (also the manage-booking credential): 8 Crockford-base32 chars, not a UUID." },
    status: { type: "string", enum: ["confirmed", "simulated", "failed"] },
    lifecycle: { type: "string", enum: ["active", "cancelled"] },
    confirmation_id: { type: ["string", "null"], description: "Channel-manager reservation id, when pushed live. Format is the channel manager's, not a UUID." },
    created_at: { type: "string", format: "date-time" },
    currency,
    checkin: date,
    checkout: date,
    nights: { type: "integer", minimum: 1 },
    total: money,
    guest: {
      type: "object",
      properties: {
        first_name: { type: "string", minLength: 1 },
        last_name: { type: "string", minLength: 1 },
        email: { type: "string", format: "email" },
        phone: { type: "string", minLength: 3 },
      },
    },
    rooms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          room_id: uuid,
          room_title: { type: "string" },
          rate_id: uuid,
          rate_title: { type: "string" },
          adults: { type: "integer", minimum: 1 },
          children: { type: "integer", minimum: 0 },
          total: money,
        },
      },
    },
    extras: {
      type: "array",
      items: {
        type: "object",
        properties: { id: uuid, name: { type: "string" }, qty: { type: "integer", minimum: 1 }, amount: money },
      },
    },
    cancellation: {
      type: ["object", "null"],
      properties: { refundable: { type: "boolean" }, cancel_by: { type: ["string", "null"], format: "date-time" } },
    },
    payment: {
      type: ["object", "null"],
      properties: {
        mode: { type: "string", enum: ["payment", "setup"] },
        amount: moneyNullable,
        currency: currencyNullable,
        card_last4: { type: ["string", "null"], pattern: "^\\d{4}$" },
        refunded: {
          type: ["object", "null"],
          properties: { amount: money, at: { type: "string", format: "date-time" } },
        },
      },
    },
  },
} as const;

const errorResponse = {
  description: "Error",
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: { error: { type: "object", properties: { type: { type: "string" }, message: { type: "string" } } } },
      },
    },
  },
} as const;

export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Roompanda Booking API",
    version: "1.0.0",
    description:
      "Commission-free direct-booking API. Each API key is scoped to a single property, so read endpoints take no property id. Authenticate with `Authorization: Bearer sk_live_…` (or `sk_test_…` for simulated bookings).",
  },
  servers: [{ url: "https://book.roompanda.com", description: "Production" }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: "Catalog", description: "Property content, availability, rates and extras." },
    { name: "Bookings", description: "Create and read bookings." },
  ],
  paths: {
    "/v1/properties": {
      get: {
        tags: ["Catalog"],
        summary: "Retrieve the property this key is scoped to",
        responses: {
          "200": {
            description: "The property",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { data: { $ref: "#/components/schemas/Property" } },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Error" },
        },
      },
    },
    "/v1/properties/{id}": {
      get: {
        tags: ["Catalog"],
        summary: "Retrieve a property by id (must match the key's property)",
        parameters: [{ name: "id", in: "path", required: true, schema: uuid }],
        responses: {
          "200": {
            description: "The property",
            content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/Property" } } } } },
          },
          "403": { $ref: "#/components/responses/Error" },
          "404": { $ref: "#/components/responses/Error" },
        },
      },
    },
    "/v1/calendar": {
      get: {
        tags: ["Catalog"],
        summary: "Per-date availability for a date picker",
        parameters: [
          { name: "from", in: "query", required: true, schema: date },
          { name: "to", in: "query", required: true, schema: date },
        ],
        responses: {
          "200": {
            description: "Closed / closed-to-arrival / closed-to-departure / min-stay by date",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Calendar" } } },
          },
          "400": { $ref: "#/components/responses/Error" },
        },
      },
    },
    "/v1/rooms": {
      get: {
        tags: ["Catalog"],
        summary: "List room content (title, description, images, facilities)",
        responses: {
          "200": {
            description: "Rooms",
            content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/Room" } } } } } },
          },
        },
      },
    },
    "/v1/availability": {
      get: {
        tags: ["Catalog"],
        summary: "Priced, bookable rooms and rates for a stay",
        parameters: [
          { name: "checkin", in: "query", required: true, schema: date },
          { name: "checkout", in: "query", required: true, schema: date },
          { name: "adults", in: "query", schema: { type: "integer", minimum: 1, default: 2 } },
          { name: "children", in: "query", schema: { type: "integer", minimum: 0 }, description: "Child count (use children_ages for exact ages)." },
          { name: "children_ages", in: "query", schema: { type: "string", pattern: "^\\d{1,2}(,\\d{1,2})*$" }, description: "Comma-separated child ages, e.g. 4,9." },
          { name: "currency", in: "query", schema: currency },
        ],
        responses: {
          "200": {
            description: "Bookable rooms with priced rate plans",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { checkin: date, checkout: date, data: { type: "array", items: { $ref: "#/components/schemas/AvailabilityRoom" } } },
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/Error" },
        },
      },
    },
    "/v1/rates": {
      get: {
        tags: ["Catalog"],
        summary: "List rate-plan definitions and cancellation policies",
        responses: {
          "200": {
            description: "Rate plans",
            content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/Rate" } } } } } },
          },
        },
      },
    },
    "/v1/extras": {
      get: {
        tags: ["Catalog"],
        summary: "List the active add-ons / upsells catalogue",
        responses: {
          "200": {
            description: "Extras",
            content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/Extra" } } } } } },
          },
        },
      },
    },
    "/v1/bookings": {
      get: {
        tags: ["Bookings"],
        summary: "List bookings (newest first)",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
          { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
        ],
        responses: {
          "200": {
            description: "Bookings page",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/Booking" } },
                    total: { type: "integer", minimum: 0 },
                    limit: { type: "integer", minimum: 1, maximum: 100 },
                    offset: { type: "integer", minimum: 0 },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Bookings"],
        summary: "Create a booking",
        description:
          "Pay-at-hotel rates confirm immediately and return the booking. Rates requiring an online deposit/prepayment return `status: \"pending_payment\"` plus a `payment_url` (Stripe hosted Checkout); the booking finalizes once payment completes.",
        parameters: [
          { name: "Idempotency-Key", in: "header", schema: { type: "string" }, description: "Safe-retry key; a repeat returns the original response." },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/BookingCreate" } } },
        },
        responses: {
          "201": {
            description: "Created (confirmed) or pending payment",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { type: "object", properties: { data: { $ref: "#/components/schemas/Booking" } } },
                    {
                      type: "object",
                      properties: {
                        data: {
                          type: "object",
                          properties: {
                            reference: { type: "string", minLength: 1 },
                            status: { type: "string", enum: ["pending_payment"] },
                            amount_due: money,
                            currency,
                          },
                        },
                        payment_url: { type: "string", format: "uri" },
                      },
                    },
                  ],
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Error" },
          "422": { $ref: "#/components/responses/Error" },
        },
      },
    },
    "/v1/bookings/{id}": {
      get: {
        tags: ["Bookings"],
        summary: "Retrieve a booking by id",
        parameters: [{ name: "id", in: "path", required: true, schema: uuid }],
        responses: {
          "200": {
            description: "The booking",
            content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/Booking" } } } } },
          },
          "404": { $ref: "#/components/responses/Error" },
        },
      },
    },
  },
  webhooks: {
    "booking.created": {
      post: {
        summary: "Sent when a booking is created (confirmed or simulated)",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookEvent" } } } },
        responses: { "200": { description: "Return 2xx to acknowledge." } },
      },
    },
    "booking.cancelled": {
      post: {
        summary: "Sent when a booking is cancelled",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookEvent" } } } },
        responses: { "200": { description: "Return 2xx to acknowledge." } },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", description: "A property-scoped API key: `sk_live_…` or `sk_test_…`." },
    },
    responses: { Error: errorResponse },
    schemas: {
      Property: { type: "object", properties: { id: uuid, name: { type: "string" } } },
      Calendar: {
        type: "object",
        properties: {
          from: date,
          to: date,
          closed: { type: "array", items: date },
          closed_to_arrival: { type: "array", items: date },
          closed_to_departure: { type: "array", items: date },
          min_stay_arrival: { type: "object", additionalProperties: { type: "integer", minimum: 1 }, description: "Minimum nights keyed by arrival date." },
          min_stay_through: { type: "object", additionalProperties: { type: "integer", minimum: 1 } },
        },
      },
      Room: {
        type: "object",
        properties: {
          id: uuid,
          title: { type: "string" },
          description: { type: ["string", "null"] },
          images: { type: "array", items: { type: "string", description: "Image URL." } },
          facilities: { type: "array", items: { type: "string" } },
          max_adults: { type: "integer", minimum: 1 },
          max_guests: { type: "integer", minimum: 1 },
          cleaning_fee: money,
        },
      },
      AvailabilityRoom: {
        type: "object",
        properties: {
          id: uuid,
          title: { type: "string" },
          description: { type: ["string", "null"] },
          images: { type: "array", items: { type: "string", description: "Image URL." } },
          facilities: { type: "array", items: { type: "string" } },
          cleaning_fee: money,
          rates: { type: "array", items: { $ref: "#/components/schemas/RatePlan" } },
        },
      },
      RatePlan: ratePlan,
      Rate: {
        type: "object",
        properties: {
          id: uuid,
          title: { type: "string" },
          meal_plan: { type: ["string", "null"] },
          prices: { type: "object", additionalProperties: money, description: "Base nightly price by room id (UUID), in the property currency." },
          refundable: { type: "boolean" },
          cancel_deadline_value: { type: ["integer", "null"], minimum: 0 },
          cancel_deadline_unit: { type: ["string", "null"], enum: ["hours", "days", null] },
          cancellation_note: { type: ["string", "null"] },
          inclusions: { type: "array", items: { type: "string" } },
          policy: { type: ["object", "null"], description: "Structured payment/cancellation/no-show policy." },
        },
      },
      Extra: {
        type: "object",
        properties: {
          id: uuid,
          name: { type: "string" },
          description: { type: ["string", "null"] },
          unit: { type: "string" },
          price: moneyNullable,
          scope: { type: "string", enum: ["room", "booking"] },
          taxable: { type: "boolean" },
          options: { type: ["array", "null"] },
          fields: { type: ["array", "null"] },
        },
      },
      Booking: booking,
      BookingCreate: {
        type: "object",
        required: ["checkin", "checkout", "rooms", "guest"],
        properties: {
          checkin: date,
          checkout: { ...date, description: "Calendar date, YYYY-MM-DD; must be after checkin." },
          currency: { ...currency, default: "GBP" },
          rooms: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["room_id", "rate_id"],
              properties: {
                room_id: uuid,
                rate_id: uuid,
                adults: { type: "integer", minimum: 1, description: "Defaults to the rate's occupancy when omitted." },
                children_ages: { type: "array", items: { type: "integer", minimum: 0, maximum: 17 }, description: "Exact age of each child (0–17)." },
              },
            },
          },
          guest: {
            type: "object",
            required: ["first_name", "last_name", "email", "phone"],
            properties: {
              first_name: { type: "string", minLength: 1 },
              last_name: { type: "string", minLength: 1 },
              email: { type: "string", format: "email" },
              phone: { type: "string", minLength: 3 },
              arrival: { type: "string", description: "Estimated arrival time, e.g. \"15:00\"." },
              requests: { type: "string" },
            },
          },
          promo_code: { type: "string" },
          marketing_opt_in: { type: "boolean" },
        },
      },
      WebhookEvent: {
        type: "object",
        description: "Signed with header `Roompanda-Signature: t=<unix>,v1=<hex>` where hex = HMAC-SHA256(endpoint_secret, `<t>.<rawBody>`).",
        properties: {
          id: { type: "string", description: "Unique event id." },
          type: { type: "string", enum: ["booking.created", "booking.cancelled"] },
          created: { type: "integer", minimum: 0, description: "Unix timestamp (seconds)." },
          data: { $ref: "#/components/schemas/Booking" },
        },
      },
    },
  },
} as const;
