// OpenAPI 3.1 description of the public /v1 API — the single source of truth,
// served at GET /v1/openapi.json. Keep in sync with the routes in
// app/routes/api.v1.*.tsx and the shapes in app/lib/api-serialize.ts.

const ratePlan = {
  type: "object",
  properties: {
    id: { type: "string" },
    parent_rate_id: { type: "string" },
    title: { type: "string" },
    meal_plan: { type: ["string", "null"] },
    currency: { type: ["string", "null"] },
    total_price: { type: "string", description: "Gross price for the whole stay." },
    available: { type: ["integer", "null"] },
    occupancy: {
      type: "object",
      properties: { adults: { type: "integer" }, children: { type: "integer" }, infants: { type: "integer" } },
    },
    refundable: { type: ["boolean", "null"] },
    free_cancel_until: { type: ["string", "null"], description: "ISO 8601 deadline for free cancellation." },
    description: { type: ["string", "null"] },
    inclusions: { type: "array", items: { type: "string" } },
    offer: {
      type: ["object", "null"],
      properties: { name: { type: "string" }, percent: { type: "number" }, original_total_price: { type: "string" } },
    },
  },
} as const;

const booking = {
  type: "object",
  properties: {
    id: { type: "string" },
    reference: { type: "string", description: "The guest-facing booking reference (also the manage-booking credential)." },
    status: { type: "string", enum: ["confirmed", "simulated", "failed"] },
    lifecycle: { type: "string", enum: ["active", "cancelled"] },
    confirmation_id: { type: ["string", "null"], description: "Channel-manager reservation id, when pushed live." },
    created_at: { type: "string", format: "date-time" },
    currency: { type: "string" },
    checkin: { type: "string", format: "date" },
    checkout: { type: "string", format: "date" },
    nights: { type: "integer" },
    total: { type: "number" },
    guest: {
      type: "object",
      properties: {
        first_name: { type: "string" },
        last_name: { type: "string" },
        email: { type: "string", format: "email" },
        phone: { type: "string" },
      },
    },
    rooms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          room_id: { type: "string" },
          room_title: { type: "string" },
          rate_id: { type: "string" },
          rate_title: { type: "string" },
          adults: { type: "integer" },
          children: { type: "integer" },
          total: { type: "number" },
        },
      },
    },
    extras: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" }, qty: { type: "integer" }, amount: { type: "number" } },
      },
    },
    cancellation: {
      type: ["object", "null"],
      properties: { refundable: { type: "boolean" }, cancel_by: { type: ["string", "null"] } },
    },
    payment: {
      type: ["object", "null"],
      properties: {
        mode: { type: "string", enum: ["payment", "setup"] },
        amount: { type: ["number", "null"] },
        currency: { type: ["string", "null"] },
        card_last4: { type: ["string", "null"] },
        refunded: {
          type: ["object", "null"],
          properties: { amount: { type: "number" }, at: { type: "string", format: "date-time" } },
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
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
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
          { name: "from", in: "query", required: true, schema: { type: "string", format: "date" } },
          { name: "to", in: "query", required: true, schema: { type: "string", format: "date" } },
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
          { name: "checkin", in: "query", required: true, schema: { type: "string", format: "date" } },
          { name: "checkout", in: "query", required: true, schema: { type: "string", format: "date" } },
          { name: "adults", in: "query", schema: { type: "integer", default: 2 } },
          { name: "children", in: "query", schema: { type: "integer" }, description: "Child count (use children_ages for exact ages)." },
          { name: "children_ages", in: "query", schema: { type: "string" }, description: "Comma-separated child ages, e.g. 4,9." },
          { name: "currency", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Bookable rooms with priced rate plans",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { checkin: { type: "string" }, checkout: { type: "string" }, data: { type: "array", items: { $ref: "#/components/schemas/AvailabilityRoom" } } },
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
          { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 100 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: {
          "200": {
            description: "Bookings page",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { data: { type: "array", items: { $ref: "#/components/schemas/Booking" } }, total: { type: "integer" }, limit: { type: "integer" }, offset: { type: "integer" } },
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
                          properties: { reference: { type: "string" }, status: { type: "string", enum: ["pending_payment"] }, amount_due: { type: "number" }, currency: { type: "string" } },
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
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
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
      Property: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
      Calendar: {
        type: "object",
        properties: {
          from: { type: "string", format: "date" },
          to: { type: "string", format: "date" },
          closed: { type: "array", items: { type: "string", format: "date" } },
          closed_to_arrival: { type: "array", items: { type: "string", format: "date" } },
          closed_to_departure: { type: "array", items: { type: "string", format: "date" } },
          min_stay_arrival: { type: "object", additionalProperties: { type: "integer" } },
          min_stay_through: { type: "object", additionalProperties: { type: "integer" } },
        },
      },
      Room: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: ["string", "null"] },
          images: { type: "array", items: { type: "string" } },
          facilities: { type: "array", items: { type: "string" } },
          max_adults: { type: "integer" },
          max_guests: { type: "integer" },
          cleaning_fee: { type: "number" },
        },
      },
      AvailabilityRoom: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: ["string", "null"] },
          images: { type: "array", items: { type: "string" } },
          facilities: { type: "array", items: { type: "string" } },
          cleaning_fee: { type: "number" },
          rates: { type: "array", items: { $ref: "#/components/schemas/RatePlan" } },
        },
      },
      RatePlan: ratePlan,
      Rate: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          meal_plan: { type: ["string", "null"] },
          prices: { type: "object", additionalProperties: { type: "number" }, description: "Base nightly price by room id, in the property currency." },
          refundable: { type: "boolean" },
          cancel_deadline_value: { type: ["integer", "null"] },
          cancel_deadline_unit: { type: ["string", "null"] },
          cancellation_note: { type: ["string", "null"] },
          inclusions: { type: "array", items: { type: "string" } },
          policy: { type: ["object", "null"] },
        },
      },
      Extra: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: ["string", "null"] },
          unit: { type: "string" },
          price: { type: ["number", "null"] },
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
          checkin: { type: "string", format: "date" },
          checkout: { type: "string", format: "date" },
          currency: { type: "string", default: "GBP" },
          rooms: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["room_id", "rate_id"],
              properties: {
                room_id: { type: "string" },
                rate_id: { type: "string" },
                adults: { type: "integer" },
                children_ages: { type: "array", items: { type: "integer" } },
              },
            },
          },
          guest: {
            type: "object",
            required: ["first_name", "last_name", "email", "phone"],
            properties: {
              first_name: { type: "string" },
              last_name: { type: "string" },
              email: { type: "string", format: "email" },
              phone: { type: "string" },
              arrival: { type: "string" },
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
          id: { type: "string" },
          type: { type: "string", enum: ["booking.created", "booking.cancelled"] },
          created: { type: "integer", description: "Unix timestamp (seconds)." },
          data: { $ref: "#/components/schemas/Booking" },
        },
      },
    },
  },
} as const;
