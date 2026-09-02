# Management API + MCP — spec

> Decision (Evan, 2026-08-27): provide a **full management API** so a PMS — or
> an AI agent over MCP — can create and edit properties, rooms, rates, content
> and the rest without our UI. **ARI and bookings are readable through the
> API, but their writes stay exclusively on the Channex pipe.** This document
> is the spec; implementation lands as separate PRs per phase.

## 1. What is explicitly NOT in this API — ever

These are product decisions, not deferrals:

- **ARI writes** — availability, date-level prices, restrictions. Channex
  pushes them to `/api/changes` and is the source of truth; a second writer
  would fight the channel (the "channel wins" arbitration in
  `ari/read.server.ts` exists precisely because one manual writer already
  causes enough trouble). The manual inventory grid stays UI-only. **Reads are
  in** (§4 phase A) — a PMS reconciling what our engine is selling against its
  own inventory is the normal integration need, and a read has no second-writer
  problem.
- **Booking writes** — bookings arrive via Channex (and the guest checkout);
  cancel/refund/modify touch money, Channex push, Stripe/Viva and email, and
  stay in the admin UI. **Reads are in** (§4 phase A): list + detail, the same
  data the admin bookings screen shows. The existing guest-side
  `POST /v1/bookings` (payment-url flow, agent booking) is a **different
  product** and is unchanged by this spec.
- **Money actions** — Stripe/Viva refunds, sold-voucher edits/comps. UI only.
- **Payment onboarding** — Stripe Connect is an OAuth the hotelier performs;
  there is no credential to POST. (Viva credentials ARE pasted strings in
  their own KV key, so a *write-only* `PUT /payments/viva` with the PR467
  save-time probe is feasible — parked as a phase-C candidate, not in scope.)
- **Secrets readback** — raw API keys, key hashes, webhook secrets and
  everything in wrangler.jsonc's "keep these OUT" list never appear in a
  response. Same rule as the UI.

## 2. Auth: a second key scope, same machinery

Today's `sk_live_/sk_test_` keys are guest-scope (read catalog, create
booking). Handing a content-editing AI the key that can create bookings — or a
booking agent the key that can rewrite the website — is the wrong blast
radius. So:

- **New prefix `ak_live_…`** ("admin key"), issued from the existing
  `/admin/api-keys` page (owner-or-super, partner-hideable — unchanged). No
  test variant: a management write is a write; simulation is a booking-side
  concept.
- Same storage and verification as `api-auth.server.ts` today: HMAC-SHA256
  hash, KV reverse index, shown once, revocable, `lastUsedAt`. The record
  gains `scope: "book" | "manage"` (absent = `"book"` for every existing key).
- **Scopes are disjoint**: `ak_` keys work only on `/v1/manage/*` (+ `/mcp`);
  `sk_` keys only on the existing guest endpoints (+ `/mcp`). No key does both;
  a PMS that needs both holds two keys.
- Canonical-host-only, exactly like `/v1` (`requireCanonicalHost`).
- Rate-limited per key via the existing `rateLimit()`, enforced inside
  `authenticateApiKey` for manage scope since the 2026-09-02 security pass:
  300 reads / 60 writes per 10 min per key (429 `rate_limited`), plus tighter
  buckets on the two things that create objects nobody may reference —
  5 teammate-invite requests per hour per property, 20 image uploads/imports
  per 10 min per key — and `/mcp` itself at 300 POSTs per 10 min per client
  with batches capped at 20 entries.
- Partner-level `pk_partner_` keys (whitelabel.md §8) are **phase C** and sit
  ON TOP of these handlers: a partner key = the same manage surface plus
  property create/list/invite, scoped to the partner's properties.

## 3. Conventions

- Namespace `/v1/manage/…`, property-scoped by the key. JSON bodies, the
  existing `apiError` envelope, ids are the internal UUIDs.
- **PATCH = sparse merge, and it is the default write verb.** This encodes the
  repo's hardest-won settings lesson: every UI saver is a narrow merge because
  whole-object writes from one screen have repeatedly wiped another screen's
  fields. `PATCH` maps directly onto `patchSettings` and friends. `PUT` exists
  only where a purpose-built full-replace primitive already does
  (`replaceRooms`/`replaceRates`, built for re-imports) and replaces the whole
  collection atomically in one KV write.
- **Validation is loud.** The UI's validators silently coerce (a bad currency
  keeps the old one, zero-amount tax rows vanish). API endpoints validate the
  payload BEFORE calling the save function and return 422 with per-field
  messages. Never inherit silent drops — an agent can't see a silent drop.
- **Clearing vs omitting:** omitted field = unchanged; explicit `null` =
  clear/revert-to-default. (The UI's "empty string means delete" trick is not
  part of the API contract.)
- **Concurrency, stated honestly:** most per-property stores are single-KV-key
  lists (read-modify-write). Two concurrent writers can lose an update — the
  same exposure two admin tabs have today. The API contract is: one write per
  request, last write wins, responses return the post-write state (do not
  GET-after-write to confirm — KV edge reads can lag up to 60s; the response
  body IS the confirmation). If partner automation makes concurrent writes
  real, the fix is the repo's own precedent — migrate that store to per-key +
  prefix list (users/partners/collections/domains already did) — not API-level
  locking.

## 4. Resource surface

### Phase A — the PMS ask (property, rooms, rates, pricing-adjacent config)

| Resource | Endpoints | Backing code (reuse, no new logic) | Notes |
|---|---|---|---|
| Property settings | `GET/PATCH /v1/manage/property` | `getSettings` / `patchSettings` + the narrow savers | PATCH allowlist: identity, address+lat/lng, check-in/out times, currency, languages, facilities (curated keys), pricingMode, timezone, cutoffs, portal policy (except `auto_refund` — owner-only in the admin, readable but not writable here since 2026-09-02), singleUnit. NOT writable: `connectedSystem` (the Channex gate — flipping it enables live traffic; superadmin UI only for now), `stripeAccountId`/`stripeChargesEnabled`, `websiteDomain` (order-sensitive claim/release flow), `liveBooking`. `websiteEnabled` IS writable (2026-08-28, after the MCP dogfood): it is content-safe by construction — the website layer renders or not, nothing is destroyed either way. |
| Property content (per-lang) | `GET/PATCH /v1/manage/property/content?lang=` | `getOverrides` / `saveOverrides` | hotelName, description, address text, phone, email per language. Renames flow through the same default-lang `hotelName` rule as the UI. |
| Rooms | `GET/POST/PATCH/DELETE /v1/manage/rooms[/:id]`, `PUT /v1/manage/rooms` | `catalog.server.ts` (`replaceRooms` for PUT) | DELETE cascades the room's price out of every rate (document in the response). Writes fire `queueGoogleAriPush` exactly like the UI. |
| Rate plans (structural) | same shape as rooms, `PUT` via `replaceRates` | `catalog.server.ts`, `rate-policy.ts`, `rate-pricing.ts` | Exposes title, mealPlan, `prices` (base price per room — structural, NOT the ARI grid), occupancyPricing, structured `policy`, inclusions, active. **`channexRateIds` is server-owned and never writable** — every write preserves it (ARI and booking pushes key on it). |
| Taxes & fees | `GET/PUT /v1/manage/taxes` | `saveTaxSettings` | One document (`taxesInclusive`, `taxes[]`, `fees[]`, `cityTax`) = one settings write; PUT is correct here. 422 on zero-amount rows instead of the UI's silent drop. |
| Extras | CRUD + `PUT` replace | `extras.server.ts` | `taxable` default-true documented in the schema. The demo-seed (`ensureExampleExtras`) must NOT run on API list — API callers get the real (possibly empty) list. |
| Promotions | CRUD | `promotions.server.ts` | `publish` semantics (auto vs code) written into the field description; codes normalized server-side. |
| Images | `POST /v1/manage/images` (multipart), `POST /v1/manage/images/import` `{url}` | `images.server.ts`, `importImageFromUrl` | Returns `{url}` to reference from any payload. 8 MB / image-\* caps as today. `images/import` takes any PUBLIC https URL behind the webhook SSRF gate (no localhost/internal/private-IP, re-checked per redirect hop) — decided 2026-08-28 so MCP agents can do photos; files can't travel over JSON-RPC. No DELETE — removal happens by dropping the reference; `queueImageCleanup` GCs unreferenced files (its `referencedBy` list already covers every store). |
| Bookings (read-only) | `GET /v1/manage/bookings` (filters: stay/created date range, status; paginated), `GET /v1/manage/bookings/:id` | `bookings.server.ts`, extend `serializeBooking` | The same facts the admin bookings screen shows: guest, stay, rooms/rates, extras, totals, status, channel reference, payment state (charge/refund refs — never gateway internals or card data). No mutation verbs exist on this resource. |
| ARI (read-only) | `GET /v1/manage/ari?from=&to=[&room_id=&rate_id=]` | `getInventory` (`ari/read.server.ts`) | The grid as our engine sells it: per-date availability, prices (major units, decoded per `fraction_size`), per-occupancy prices, restrictions. Window capped (start: 400 days/request) — it is a D1 read fanning out per date. This is the reconciliation surface: "what is RoomPanda selling" vs the PMS's own inventory. No write verbs exist. |

### Phase B — content & website

| Resource | Endpoints | Backing code | Notes |
|---|---|---|---|
| Website pages | CRUD `/v1/manage/site/pages[/:id]` | `site.server.ts`, `pages.ts` | Slug rules (`RESERVED_PAGE_SLUGS`, `MAX_PAGES`), home is fixed. |
| Sections (structure) | `PUT /v1/manage/site/pages/:id/sections` | `savePageSections` | Returns orphaned images GC'd. Structure is language-independent by design. |
| Copy (per-lang) | `PATCH /v1/manage/site/pages/:id/copy?lang=` | `saveSiteCopy` | Scoped to the page's own keys — the API inherits the "editing German must never touch another page" guarantee for free. Footer copy is its own endpoint (`footerCopy` is a separate namespace on purpose). |
| Gallery | `GET/PUT /v1/manage/gallery`, `PATCH …/gallery/text?lang=` | `gallery.server.ts` | PUT takes the whole ordered list in ONE call (`addImages` batch rule); `MAX_GALLERY_IMAGES`. |
| Email templates | `GET/PATCH /v1/manage/emails/:templateId?lang=` | `saveEmailContent` | The 6 template ids + field allowlist from `emailDef`. No test-send endpoint (SparkPost side effect stays in the UI). Sender identity: `PATCH /v1/manage/property` allowlist addition via `saveEmailSettings`. |
| Funnel copy + search/hero | `PATCH /v1/manage/content/:pageId?lang=`, `PATCH /v1/manage/content/search?lang=` | `content` store savers | `EDITABLE_PAGES` ids; `heroImage` rides the default language (existing rule). |
| Voucher catalog | CRUD `/v1/manage/voucher-products` | `vouchers.server.ts` product fns | Config only. Sold vouchers are excluded (§1). |
| Branding/theme | `PATCH /v1/manage/brand` | `saveBrand` / `saveThemeTokens` | `themeFont` restricted to `FONT_PAIRS` ids; invalid values are 422, not silently ignored. `GET /v1/manage/brand-kit` returns the derived kit (prompt + tokens.json) — pure read, useful to agents building a matching site. |
| Reviews | `GET /v1/manage/reviews`, `POST …/reviews/:bookingId/response` | `reviews.server.ts` (`setReviewResponse`) | Responding to guest reviews is a natural AI task; the guest's review text itself is never writable. There is deliberately NO hide/delete — a property can only respond, never bury criticism (the `hidden` column is a dormant platform-level valve, not a property power), so the API exposes respond only. |

### Phase C — accounts, provisioning, partner API

| Resource | Endpoints | Notes |
|---|---|---|
| Team | `GET /v1/manage/team`, `POST …/invites`, `DELETE …/members/:email`, `PATCH …/members/:email/areas` | **Invites are requests (since the 2026-09-02 security pass):** `POST` parks the email in `pending` and emails the OWNER; the person is added — and emailed a sign-in link — only when the owner approves on the admin Team page. A key is not a person, and the account it used to mint outright outlived the key and reached owner-class UI actions. Still the ONE manage endpoint that sends email (to the owner). `MEMBER_AREAS` complement-storage handled server-side. |
| Webhooks | CRUD | Secret returned once at creation, like keys. SSRF gate (`isSafeWebhookUrl`) already exists. |
| Google Hotels | `GET/PATCH /v1/manage/google` | The OFF→ON / ON→OFF transition side effects (full resync / block) computed from the pre-write value, exactly like the fixed UI path. |
| Partner API | `pk_partner_` keys; `POST /partner/v1/properties` (Channex-import driven — the onboard flow takes a pasted `user-api-key` and property id today, same inputs as the endpoint), `…/invites`, `GET …/properties` + usage | whitelabel.md §8; the property-create path can also accept a structured payload (the `importBookingListing` split — parse vs import — was built so the import half takes a payload from anywhere). |
| Viva credentials | `PUT /v1/manage/payments/viva` (write-only) + the PR467 probe | Candidate, decide when a partner asks. |
| Registry fields | `PATCH /v1/manage/property/listing` (slug, public, directoryListed) | `properties.server.ts` slug rules (`slugError`, `RESERVED_SLUGS`) apply; ownership/transfer/delete stay off the property-scoped key (partner API territory). |
| Create property | `POST /v1/manage/properties` — **SHIPPED 2026-08-29**, superseding the earlier "create is partner-API territory" stance (product call: the UI lets any owner add a property, so the API should too) | Owner + partnerId copied from the key property's REGISTRY RECORD (an API key has no user; mirrors what the UI stamps from the creator). Response mints and returns a management key for the NEW property (shown once) — the calling ak_ key stays scoped to its own property, so without it the caller could create a property it can never touch; a leaked key's blast radius over EXISTING properties is unchanged. Refused (409) when the key's property is ownerless (the new property would be admin-unreachable); capped at 50 properties per owner (the registry is a single KV value read everywhere — an agent loop must not grow it unboundedly). MCP tool `create_property` says explicitly that the current MCP session keeps targeting the ORIGINAL property. |

Superadmin/global resources (properties registry admin, users/roles, partners,
collections, domains) have **no key story in this spec** — they stay
session-auth'd UI until the partner API defines who may hold such power.

## 5. MCP

`/mcp` stays the single endpoint; the advertised tool list is **filtered by
key scope**. An `sk_` key sees today's booking tools, an `ak_` key sees the
management tools — same `TOOLS` table mechanism in `mcp.ts`, same in-process
re-dispatch to the `/v1/manage` handlers (one implementation, zero drift, new
REST fields appear in MCP for free).

Tool-design rules for the manage set (they matter more than the REST docs —
they're all the agent reads):

- Every destructive tool names its cascade in the description
  (`delete_room` also removes that room's price from every rate).
- Sparse-update tools say "omitted fields are unchanged; pass null to clear".
- Language-scoped tools (`update_page_copy`, `update_property_content`) say
  which language they touch and that structure is edited elsewhere — steering
  the agent into the same structure/text split that keeps the UI safe.
- `upload_image` / `import_image` return the url and say where it can be used.
- Read tools come first in the list (agents read top-down): `get_property`,
  `list_rooms`, `list_rates`, `list_bookings`, `get_booking`, `get_ari`, then
  writes. `get_ari` and the booking tools say explicitly that they are
  read-only and that changes flow through the property's channel manager — so
  an agent asked to "close tomorrow" or "cancel this booking" explains where
  that happens instead of hunting for a tool that doesn't exist.

## 6. Side-effect policy

Same behavior as the UI, made explicit in the docs and tool descriptions:

- `queueGoogleAriPush` fires on rooms/rates/taxes/promotions writes (as today).
- `queueImageCleanup` fires on image-bearing removals (as today).
- **No implicit email.** The only sender is the phase-C invite endpoint.
- No Channex calls from any manage endpoint (there is nothing to call — ARI
  and bookings are out of scope, and the connectivity gate is not writable).

## 7. OpenAPI, SDK, CLI

`openapi.ts` stays the single source of truth and grows the manage paths,
served at `/v1/openapi.json` (manage schemas included regardless of key — the
schema is not a secret). Product order stays **API → SDK → MCP → CLI**; MCP
ships with phase A (it is the stated reason for this project), SDK/CLI follow
adoption.

## 8. Implementation order

1. **PR 1 — auth:** `scope` on `ApiKeyRecord`, `ak_` issuance + UI toggle,
   `authenticateManageKey`, rate limits. Small, testable alone.
2. **PR 2 — phase A reads** (`GET` property/content/rooms/rates/taxes/extras/
   promotions) + OpenAPI + MCP read tools. Proves the dispatch plumbing.
3. **PR 3+ — phase A writes**, one resource per PR (validation is the bulk of
   each), each with its MCP tool(s) and a round-trip test in the vitest D1/KV
   shim style of `ingest-roundtrip.test.ts`.
4. Phase B, then C, same rhythm.

## 9. Risks / open questions

- **Lost updates on single-key lists** — accepted for v1 (§3); revisit per
  store when automation traffic is real.
- **Partner-hidden pages vs API parity:** `hiddenPages` hides UI pages from a
  partner's hotels, but a manage key sees everything. Since issuing keys is
  owner-or-super and the api-keys page itself is partner-hideable, the
  partner controls exposure by not issuing keys — document this; revisit if a
  partner wants area-scoped keys (the `MEMBER_AREAS` model is the natural
  shape).
- **`PATCH /property` allowlist drift:** every new settings field must be
  explicitly classified (writable / not writable / phase-C) at review time —
  add a checklist item to the settings type.
- **Does the PMS need `connectedSystem` write** (to finish provisioning
  without us)? Deferred to the partner API decision — it is the live-traffic
  switch and deserves its own review.
