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
        properties: {
          id: uuid,
          name: { type: "string" },
          option: { type: ["string", "null"], description: "Chosen option name, for configurable extras." },
          qty: { type: "integer", minimum: 1 },
          amount: money,
          room_title: { type: ["string", "null"], description: "The room this extra is attached to; null = whole stay." },
          info: { type: ["string", "null"], description: "One-line summary of captured info fields." },
        },
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
    version: "1.6.0",
    description:
      "Commission-free direct-booking API. Each API key is scoped to a single property, so read endpoints take no property id. Authenticate with `Authorization: Bearer sk_live_…` (or `sk_test_…` for simulated bookings). All prices are in the property's own configured currency — there is no currency conversion, and currency is never a client input.",
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
        parameters: [
          { name: "lang", in: "query", schema: { type: "string" }, description: "Content language (see the property's `languages`); defaults to the property's default language." },
        ],
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
        parameters: [
          { name: "id", in: "path", required: true, schema: uuid },
          { name: "lang", in: "query", schema: { type: "string" }, description: "Content language (see the property's `languages`); defaults to the property's default language." },
        ],
        responses: {
          "200": {
            description: "The property",
            content: { "application/json": { schema: { type: "object", properties: { data: { $ref: "#/components/schemas/Property" } } } } },
          },
          "401": { $ref: "#/components/responses/Error" },
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
          "401": { $ref: "#/components/responses/Error" },
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
          "401": { $ref: "#/components/responses/Error" },
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
        ],
        responses: {
          "200": {
            description: "Bookable rooms with priced rate plans. Prices are in the property's own currency (returned as `currency`); there is no currency conversion.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { checkin: date, checkout: date, currency, data: { type: "array", items: { $ref: "#/components/schemas/AvailabilityRoom" } } },
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/Error" },
          "401": { $ref: "#/components/responses/Error" },
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
          "401": { $ref: "#/components/responses/Error" },
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
          "401": { $ref: "#/components/responses/Error" },
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
          "401": { $ref: "#/components/responses/Error" },
        },
      },
      post: {
        tags: ["Bookings"],
        summary: "Create a booking",
        description:
          "Pay-at-hotel rates confirm immediately and return the booking. Rates requiring an online deposit/prepayment return `status: \"pending_payment\"` plus a `payment_url` (Stripe hosted Checkout); the booking finalizes once payment completes. Add-ons ride along via `rooms[].extras` (per-room) and the top-level `extras` (whole stay) — VAT-applicable extras are folded into the taxed total, exempt ones added on top, identically to the hosted checkout.",
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
          "502": { $ref: "#/components/responses/Error" },
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
          "401": { $ref: "#/components/responses/Error" },
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
      Property: {
        type: "object",
        description:
          "The property's display content for building a booking frontend. Text fields (hotel_name, description, address, property_type) are localized by `?lang=`. `pricing_display` explains how the all-in total composes on top of the room-only rates from /v1/availability — for display; the authoritative total always comes from POST /v1/bookings.",
        properties: {
          id: uuid,
          name: { type: "string", description: "Internal/admin name." },
          hotel_name: { type: "string", description: "Guest-facing display name." },
          property_type: { type: ["string", "null"], description: "Short type label, e.g. \"Boutique hotel\"." },
          description: { type: ["string", "null"] },
          address: { type: ["string", "null"], description: "Free-text display address." },
          phone: { type: ["string", "null"] },
          email: { type: ["string", "null"] },
          location: {
            type: "object",
            properties: {
              city: { type: ["string", "null"] },
              region: { type: ["string", "null"] },
              postal_code: { type: ["string", "null"] },
              country: { type: ["string", "null"], description: "ISO 3166-1 alpha-2, e.g. GB." },
              latitude: { type: ["string", "null"] },
              longitude: { type: ["string", "null"] },
            },
          },
          currency,
          timezone: { type: ["string", "null"], description: "IANA timezone, e.g. Europe/London." },
          checkin_time: { type: ["string", "null"], description: "e.g. \"15:00\"." },
          checkout_time: { type: ["string", "null"], description: "e.g. \"11:00\"." },
          languages: { type: "array", items: { type: "string" }, description: "Enabled content languages (usable as `?lang=`)." },
          terms_url: { type: ["string", "null"], format: "uri" },
          privacy_url: { type: ["string", "null"], format: "uri" },
          single_unit: { type: "boolean", description: "The property is one bookable unit (apartment mode)." },
          amenities: {
            type: "array",
            items: { type: "string" },
            description:
              "Property-wide structured amenity keys (fixed vocabulary, e.g. wifi, kitchen, elevator — same keys as room `amenities`).",
          },
          amenity_options: {
            type: "object",
            additionalProperties: { type: "string" },
            description: 'Enum amenities keyed by name, e.g. { "parking_type": "Free", "pool_type": "Outdoors", "internet_type": "Free" }.',
          },
          unit_size: {
            type: "object",
            description: "Unit size for single-unit properties; fields are null until the host sets them.",
            properties: {
              bedrooms: { type: ["number", "null"], description: "0 = studio." },
              bathrooms: { type: ["number", "null"], description: "May be a half, e.g. 1.5." },
              beds: { type: ["number", "null"] },
            },
          },
          cover_image: { type: ["string", "null"], description: "Cover photo URL path." },
          logo: { type: ["string", "null"], description: "Logo URL path (shown in the booking header)." },
          logo_hide_name: { type: "boolean", description: "When true, the header shows the logo only; when false, the hotel name text is shown alongside the logo." },
          theme: {
            type: "object",
            description: "Brand tokens so an external frontend can match the property's look.",
            properties: {
              accent: { type: "string", description: "Accent colour, hex." },
              background: { type: ["string", "null"], description: "Page background, hex." },
              font: { type: ["string", "null"], description: "Curated font-pair id; null = default fonts." },
            },
          },
          pricing_display: {
            type: "object",
            properties: {
              taxes_inclusive: { type: "boolean", description: "true = rate prices already include the taxes below." },
              taxes: { type: "array", items: { type: "object", properties: { name: { type: "string" }, rate_percent: { type: "number" } } } },
              fees: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    kind: { type: "string", enum: ["percent", "fixed"] },
                    amount: { type: "number", description: "Percent when kind=percent, else the fixed amount per basis unit." },
                    taxable: { type: "boolean", description: "The taxes above apply on top of this fee." },
                    basis: {
                      type: ["string", "null"],
                      enum: ["booking", "room", "room_night", "person", "person_night", null],
                      description: "Fixed fees only: how the amount multiplies (booking = flat per stay). null for percent fees.",
                    },
                  },
                },
              },
              city_tax: {
                type: ["object", "null"],
                properties: {
                  name: { type: "string" },
                  amount: money,
                  basis: { type: "string", enum: ["person_night", "room_night", "room_stay"] },
                  taxable: { type: "boolean" },
                  children_exempt: { type: "boolean" },
                  max_nights: { type: ["integer", "null"], minimum: 1, description: "Cap on nights charged; null = no cap." },
                  seasons: {
                    type: ["array", "null"],
                    description:
                      "Seasonal nightly rates (annual recurring MM-DD ranges; from > to wraps the year end). Each night is charged at its date's rate; dates outside every season use `amount`. null = flat rate.",
                    items: {
                      type: "object",
                      properties: {
                        from: { type: "string", pattern: "^\\d{2}-\\d{2}$", description: "Inclusive start, MM-DD." },
                        to: { type: "string", pattern: "^\\d{2}-\\d{2}$", description: "Inclusive end, MM-DD." },
                        amount: money,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
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
          facilities: { type: "array", items: { type: "string", description: "Free-text facilities (host-authored)." } },
          amenities: { type: "array", items: { type: "string" }, description: "Structured amenity keys (fixed vocabulary, e.g. wifi, kitchen, washer_dryer)." },
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
          facilities: { type: "array", items: { type: "string", description: "Free-text facilities (host-authored)." } },
          amenities: { type: "array", items: { type: "string" }, description: "Structured amenity keys (fixed vocabulary, e.g. wifi, kitchen, washer_dryer)." },
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
      ExtraSelection: {
        type: "object",
        required: ["extra_id"],
        description:
          "An add-on selection (see GET /v1/extras for the catalogue). Prices are always resolved server-side — only ids, quantity and info values travel. An invalid selection (unknown extra, wrong scope, missing option_id or required info field, room/rate exclusion) fails the whole booking with 422 `invalid_extra`.",
        properties: {
          extra_id: uuid,
          option_id: { ...uuidNullable, description: "Required when the extra has options (configurable)." },
          qty: { type: "integer", minimum: 1, maximum: 99, default: 1 },
          info: { type: "object", additionalProperties: { type: "string" }, description: "Values for the extra's info fields, keyed by field id. Required fields must be non-empty." },
        },
      },
      BookingCreate: {
        type: "object",
        required: ["checkin", "checkout", "rooms", "guest"],
        properties: {
          checkin: date,
          checkout: { ...date, description: "Calendar date, YYYY-MM-DD; must be after checkin." },
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
                extras: { type: "array", items: { $ref: "#/components/schemas/ExtraSelection" }, description: "Room-scoped add-ons for this room. Per-person extras price against this room's guests." },
              },
            },
          },
          extras: { type: "array", items: { $ref: "#/components/schemas/ExtraSelection" }, description: "Booking-scoped add-ons (offered once for the whole stay). Per-person extras price against the whole party." },
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
