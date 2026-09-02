# Security review — 2026-09-02 (pass 3)

Third-pass review of [channex-booking-page](https://github.com/daviesevan-svg/channex-booking-page) on `main` at `a59375a` (PR 505 merged). Builds on [pass 2](security-review-2026-08-22-pass2.md) (2026-08-22, `32e6824`); it re-read the code that landed since rather than re-arguing pass 2's verdicts.

**Scope:** everything merged after pass 2 — the Management API + MCP (PR 489–504: `ak_` keys, ~66 write operations, team, webhooks, image import-by-URL, property creation), Viva ISV model + persisted diagnostics (PR 483–486), the PR 480 permission flips; plus a fresh read of admin authorization, guest surfaces, payments, and the data layer, and live probes of production headers and redirects. Style nits and the racy KV `rateLimit` used as a blunt throttle are out of scope, as before.

**Fixes shipped with this review** (findings H1–H4 below). Everything else is recorded, not patched; each carries a recommended fix.

Do not merge other work from this document unless a later pass treats it as the same bar.

---

## Executive summary

The core defences still hold: cross-partner isolation, `ak_`/`sk_` scope separation with no property override on any of the 41 manage routes, Stripe session binding on every finalize caller, allowlisted settings writes, parameterised and tenant-scoped SQL, escaped or protocol-restricted HTML/href/JSON-LD sinks (including the website copy the API can now write), path-scoped CSP/framing. Pass 2's M4 and M6 are fixed; H1 (test keys charging live) holds.

Four things needed fixing now:

- **H1** — any signed-in admin could register a property whose *id* equals another hotel's *slug* and capture that hotel's booking URL (ids match before slugs); the same door re-opened a *deleted* property's id and inherited its connected Stripe account, Viva credentials, live API keys and webhook secrets.
- **H2** — production served the whole site, checkout and admin login included, over plain HTTP (`http://book.roompanda.com` → 200), with no HSTS.
- **H3** — a live open redirect on the booking origin: `GET /%2F%2Fevil.com/contact` → `302 Location: ///evil.com`.
- **H4** — a management API key could mint a durable admin *session* account via `POST /v1/manage/team`, and that account reached owner-class UI actions (Channex connect/disconnect) the API deliberately excludes.

The rest is Medium/Low: Viva keeps a mismatched charge without refunding, a Viva double-refund race, the image GC deleting partner assets and feed snapshots, no rate limiting on the management surface, two KV read-modify-write clobbers, and the pass-2 leftovers.

---

## Findings

### High

#### H1 — Property-id / slug collision hijacks a hotel's URL; deleted ids were reclaimable with their credentials

**Status: fixed in this branch.**

**Evidence.** `admin/properties.tsx` `intent === "add"` took `id` straight from the form behind `requireAdmin` only. `resolvePropertyId` matches ids before slugs (`properties.server.ts`), and `addProperty` only refused a duplicate *id* — `slugError` closed the mirror case (a slug equal to an existing id) but nothing closed this one. `removeProperty` deliberately left `settings:{id}` (with `stripeAccountId`, `liveBooking`, `connectedSystem`), `viva_config:{id}`, `api_keys:{id}`, `webhooks:{id}` and all D1 bookings in place; `identifyApiKey` never consulted the registry, so a deleted property's `ak_` keys kept working on 37 of 41 manage routes. Property ids are public (guest URLs, the Viva webhook address).

**Impact.** A teammate on any property — or anyone at all while `ADMIN_EMAILS` is empty — posts `intent=add&id=spilmanhotel`: `book.roompanda.com/spilmanhotel` now resolves to a property they own, with their Stripe account. Or they re-add a deleted hotel's UUID and become owner of its live payment setup and guest data. The Channex onboard also re-imported an already-registered property for whoever held the hotel's Channex key, overwriting rooms/rates/settings (pass-3 auditor finding; same root).

**Fix applied.**
- `propertyIdError()` (format, reserved, existing id, **existing slug**) and `addProperty` throws on it; re-adding your own existing property stays a no-op (the Channex import re-runs it), anyone else is refused.
- Custom ids on the Properties page are superadmin-only; everyone else gets a UUID.
- `removeProperty` writes a tombstone `property_tombstone:{id}` naming the owner; `addProperty` refuses a tombstoned id for anyone but that owner (superadmin `reclaim` overrides).
- New `property-delete.server.ts` `deletePropertyForGood()` — the route's entry point — revokes every API key (`revokeAllApiKeys`), deletes webhooks, deletes `viva_config`, clears `stripeAccountId`/`stripeChargesEnabled`/`liveBooking`/`connectedSystem`/`googleAriPush`, then removes the row. Content stays so the same owner can undo.
- `identifyApiKey` 401s when the key's property is not in the registry.
- Tests: `properties-registry.test.ts`.

#### H2 — Production served over plain HTTP, no HSTS

**Status: fixed in this branch (Worker side); zone setting still to flip.**

**Evidence (live, 2026-09-02).** `curl -I http://book.roompanda.com/` → `HTTP/1.1 200 OK` with the full page; `/admin/login` likewise; no `Strict-Transport-Security` on any response. The Spilman custom domain redirected (its own zone). Cookies are `Secure` (APP_URL is https) so sessions did not leak, but the booking page, checkout form and login form were deliverable over plaintext to anyone who typed the bare hostname.

**Fix applied.** `app/lib/https-redirect.ts`: the Worker 301s (308 for non-GET) any `http:` request to its `https:` twin for every hostname it serves, custom hotel domains included, and stamps `Strict-Transport-Security: max-age=31536000` on https responses. No `includeSubDomains` — a hotel's custom domain may have unrelated subdomains. Both are gated on `APP_URL` being https so `npm run dev` on `http://localhost` is untouched. Wired first in `workers/app.ts`, before anything that could set a cookie. Tests: `https-redirect.test.ts`. **Still do:** turn on "Always Use HTTPS" + HSTS in the Cloudflare zone as belt-and-braces.

#### H3 — Open redirect via the `:channelId` segment

**Status: fixed in this branch.**

**Evidence (live).** `https://book.roompanda.com/%2F%2Fexample.com/contact` → `302 Location: ///example.com` → browsers resolve to `https://example.com`. `contact.tsx`'s loader and `manage.tsx`'s logout branch built `redirect(homePath(params.channelId))` *before* resolving the property; React Router decodes `%2F` into the param, and `///evil.com` is an absolute URL. `admin/lang.tsx` accepted `/\evil.com` (only `//` was refused) and any `/…` path.

**Fix applied.** Both handlers resolve the property first (a bogus segment 404s like every other guest route). `basePath`/`homePath` additionally refuse any segment that is not `^[A-Za-z0-9][A-Za-z0-9_.-]*$` — the router-decoded `//evil.com` becomes a root link, never a protocol-relative URL. `admin/lang` now accepts only `/admin…` paths and refuses a second slash *or* backslash. Tests: `base.test.ts`.

#### H4 — A management key could mint an admin account, and that account reached owner-class actions

**Status: fixed in this branch.**

**Evidence.** `POST /v1/manage/team` called `addPropertyMember` + `upsertUser`; `canSignIn` admits any known user even with `ADMIN_EMAILS` set. That session then reached the Connectivity connect/disconnect action (`requireAdmin` + `requirePageAllowed` + `currentPropertyId`, no owner gate — the spec calls `connectedSystem` "the live-traffic switch … superadmin UI only") and booking cancel (no gate; refund has one). The account survived key rotation; the owner saw it only by opening Team. A prompt-injected agent that reads "invite ops@attacker.tld" in a review does this for free.

**Fix applied.**
- API invites are now **requests**: `POST /v1/manage/team` parks the email in `pending_invites:{pid}` (new `team-invites.server.ts`), emails the **owner** (`sendTeamInviteRequestEmail`, not the invitee), and returns 202 with `pending` in the team payload. Nobody joins and no user record or sign-in link is created until the owner approves on the admin Team page (new Approve / Decline UI; approval runs the same `inviteTeammate` path as a direct invite, this property only). Idempotent per email; one owner notification per distinct request. MCP tool + OpenAPI + `docs/management-api.md` updated.
- Connectivity connect/disconnect gated on `canManageProperty` (buttons disabled with the owner-only hint for others).
- Booking **cancel** is left available to teammates on purpose — it is a front-desk operation, audited via `cancelledBy` — now that the API can no longer create the account that made it dangerous. Revisit if a desk role is ever split out (see M8).
- Tests: `manage-team-webhooks-google.test.ts` (pending → approve flow).

---

### Medium

#### M1 — Viva: a charge the finalize tripwire rejects is kept, never refunded

`viva.return.tsx` catches `SessionBindError` and redirects the guest back to checkout; `api.viva-webhook.tsx` logs and 200s; `finalizeFromVivaOrder` has no refund leg — unlike `rejectUnboundStripeSession`, which refunds on amount/currency mismatch. Reachable because the Viva order body carries **no currency** (`viva.server.ts` `orderRequestBody`): the guest is charged in the merchant account's currency, `assertCollectedPayment` compares against the property's. Connect-time only checks the code is in `VIVA_CURRENCIES`; the property currency can change afterwards (admin General, or `PATCH /v1/manage/property`). The guest pays, gets no booking, is sent back to pay again. **Fix:** mirror the Stripe path — on `shouldRefundMismatchedSession(reason)` call `vivaRefund` for the transaction and `deletePending`; refuse a currency change while a gateway is connected; record the merchant currency at first successful finalize.

#### M2 — Viva double refund (no idempotency key; read-then-write guard)

`refunds.server.ts` checks `p.refund` then calls `vivaRefund` with no idempotency key and persists via a non-conditional `updateBooking`; the guest cancel in `manage-booking.tsx` is an unconditional update with no rate limit on the `cancel` intent. Two concurrent cancels with `autoRefund` on refund twice (and run `incrementAvailability` + Channex cancel twice). Stripe is safe (`refund_${reference}` idempotency key). **Fix:** conditional `UPDATE … WHERE lifecycle='active'` and proceed only on `changes===1`; claim the refund atomically (D1 `INSERT … ON CONFLICT DO NOTHING`, like `claimWindow`) before calling Viva; rate-limit `cancel`.

#### M3 — Image GC deletes objects it doesn't own

`deleteUnreferencedImages` (`image-gc.server.ts`) accepts any `/images/<key>` and spares only keys some *property* store still references — it does scan every other property, so live room photos are safe, but partner brand assets (`partners/<id>/logo/…`, same bucket) and the constant-key Google feed snapshot (`feeds/google-hotels-all.xml`, stored via `getImagesBucket()`) are not in that scan, nor is any tenant's upload not yet referenced. The management API accepts any `startsWith("/images/")` reference. A room `images` PATCH naming a partner's logo then a PATCH without it deletes the logo for every hotel under that partner. **Fix:** only delete keys under the calling property's own prefixes (`gallery/<pid>/`, `catalog/<pid>/`, `manage/<pid>/`); validate incoming `/images/` references to those prefixes on write; move feed snapshots out of the images bucket or behind a prefix the GC refuses.

#### M4 — No rate limiting on `/v1/manage/*` or `/mcp`; `auto_refund` writable by the API

`rateLimit(` is called on nine paths, none of them management routes or `/mcp`; MCP JSON-RPC batches are unbounded. `docs/management-api.md` §2 promises 300 reads / 60 writes per 10 min. Consequences with one key: unlimited hotel-branded invite-request emails to the owner (now), unlimited 8 MB image imports that are never GC'd (see M3), Google push flip-flops each queuing a resync, property creations in a burst (racing the 50 cap, M5). Separately, `portal.auto_refund` is owner-only in the UI (`portal.tsx` `persistAutoRefund: canOwn`) but accepted unconditionally by `validatePropertyPatch` — a partner_admin blocked in the UI can set it through a key they mint. **Fix:** `rateLimit(\`apimanage:${keyId}:r|w\`)` inside `authenticateApiKey` for scope `manage`; cap MCP batch length; tight buckets for invite and image import; drop `auto_refund` from the API allowlist.

#### M5 — KV read-modify-write clobbers on the global registry and the per-property key list

The `properties` registry is one KV key written by every tenant (`addProperty`, `renameProperty` via `PATCH /v1/manage/property/content` `hotel_name`, team ops, `setPropertyOwner`, slug, public): a lost update silently undoes a teammate removal or an ownership transfer across tenants, and the `MAX_OWNED_PROPERTIES` check is check-then-write. `identifyApiKey` rewrites `api_keys:{pid}` on **every** authenticated request to stamp `lastUsedAt`, racing `issueApiKey` (new key vanishes from the list but its index exists → 401s forever, invisible, unrevocable) and `revokeApiKey`. **Fix:** per-property registry keys or a D1 table; stamp `lastUsedAt` in its own key (or only when > 60 s old), never RMW the list on the read path.

#### M6 — Channex onboard overwrote an already-registered property

`onboard-channex.tsx` `importFromChannex` called `addProperty(pid…)` (a no-op on an existing id) then unconditionally `saveOverrides` / `patchSettings` / `replaceRooms` / `replaceRates`. Anyone with the hotel's Channex API key and any admin session could re-run the import and replace a live catalogue. **Partly closed by H1:** `addProperty` now throws when the id belongs to another account, which aborts the import before any write. Still worth an explicit `canAccess` check with a clear "already imported by another account" message.

#### M7 — Pass-2 leftovers still open

| Pass 2 | Status | Evidence |
|---|---|---|
| M1 simulated bookings decrement live ARI, email, fire webhooks | open | `booking-finalize.server.ts` `inventoryHeld: status !== "failed"`; reachable with a test key (no `claimWindow`) or web test-mode checkout |
| M2 web uncarded live bookings have no D1 claim | open | `checkout.tsx` finalize with `payment === undefined` behind KV `rateLimit(book:…, 10, 600)` only |
| M3 adults cap only on URL reader | partial | cart capped by room capacity; `GET /v1/availability` still uncapped adults and nights |
| M5 confirmation page shows "Confirmed" for any reference | open | `confirmation.tsx` never calls `getBookingByReference` |
| M7 teammate-open owner controls | partial | PR 480 gated payments/live/slug/public/auto-refund; **still open:** custom domain claim/remove (`website.tsx`), currency/pricing mode (`general.tsx`), booking cancel (by decision, H4) — connectivity fixed here |
| L1 Viva `merchantTrns` not compared | open (mitigated) | order-code mapping is the bind |
| L2 checkout intent claimed before rate limit | open | `checkout.tsx` |
| L3 fail-open without D1/KV | open (latent) | `rate-limit.server.ts`, `checkout-idem.server.ts` |
| L5 `scrapeUrl` no allowlist | open | sole caller normalises to `booking.com` first |
| L6 Channex inbound no replay window | open | |
| L7 review submit unthrottled | open | |
| L8 colours unsanitised at render | mitigated at every write path; the collections form (`admin/collection.tsx` `customColor`) is the one raw path (superadmin-only) → CSS injection on `/c/*` |
| L9 `admin/lang` | fixed (H3) | |
| M4, M6 | **fixed** | `partnerId` stamped on add/clone; `canManageProperty` in use |

#### M8 — `removeUser` does not strip ownerships or memberships

`users.server.ts` `removeUser` deletes only `user:{email}`; `PropertyRef.owner` and `members[]` keep the address, and `upsertUser` recreates the record on the next sign-in (open signup) or the next invite anywhere. A "deleted" rogue owner is owner again. **Fix:** strip the email from every `owner`/`members`/`memberHiddenAreas` (or transfer to the acting superadmin) and consult a denylist in `canSignIn`.

---

### Low

| ID | Finding | Evidence | Recommended fix |
|---|---|---|---|
| L1 | Collections can list partner hotels and `/c/*` is served on every host | `admin/collection.tsx` `addMember` — target property unchecked; `collection.$collectionSlug.tsx` no host gate | invite-only when the actor can't access the target; exclude `partnerId` properties; `requireCanonicalHost` |
| L2 | Channex ingest: unbounded date ranges, rows for empty `hotel_code`, raw D1 error echoed | `ari/ingest.server.ts` `eachDate`, `api.changes.tsx` | clamp to `[today−1, today+730]`, require non-empty ids, generic 422 |
| L3 | List feeds rebuilt from KV/D1 on every anonymous GET | `feeds.hotel-list.tsx`, `feeds.google-vr.tsx` | snapshot like the merged feeds, or Cache API keyed on pathname |
| L4 | Image transform cache keyed on the full URL (`?n=` busts it) | `routes/image.tsx` | normalise to `${pathname}?w=` |
| L5 | Custom-domain reservation squatting by any teammate; 50-key sweep starves | `website.tsx` (no owner gate), `domains.server.ts` `pendingDomainSetups(50)` | `canManageProperty`; cap per property; paginate with a cursor |
| L6 | Outbound webhooks awaited with no timeout on the guest's request path | `webhooks.server.ts` `dispatchWebhook` | `AbortSignal.timeout(5000)` + `waitUntil` |
| L7 | PII in Worker logs (recipient emails; whole Viva diagnostics JSON) | `email.server.ts`, `viva-diag.server.ts` | hash or count |
| L8 | Guest strings uncapped (names, phone, requests, voucher message) | `checkout.tsx` `GuestSchema`, `voucher-buy.tsx` | `.max()`; strip CR/LF from anything that reaches a subject |
| L9 | Stripe signature parser keeps only the last `v1=` | `stripe.server.ts` | accept if any `v1` matches (secret rotation) |
| L10 | `/admin/properties` loader ships every visible property's `members` + `memberHiddenAreas` to teammates | `properties.tsx` `rows` | project |
| L11 | `isSafeWebhookUrl` misses IPv6-mapped IPv4, NAT64, `*.localhost` | `webhooks.server.ts` | reject `::ffff:`/`64:ff9b:`/`.localhost`; platform blocks private fetches anyway |
| L12 | Image routes echo raw exception text | `api.v1.manage.images*.tsx` | fixed strings |
| L13 | No `Permissions-Policy` on the booking engine | live headers | add a conservative one |
| L14 | Embed HTML `Cache-Control: public` but varies on the language cookie | `embed.$channelId*.tsx` | `Vary: Cookie` or `?lang=` only |
| L15 | Reviews respond still `isOwnerOrSuper` (partner_admin blocked) | `reviews.tsx` | `canManageProperty`, for consistency |

---

## Verified and sound

- **Cross-partner isolation:** sessions host-bound both directions; `getVisibleProperties` / `canAccess` / `currentPropertyId` remain the sole chokepoints; every property-scoped action re-runs its guard (no loader-only gates); no action uses a form-supplied property id without a visibility check except the collections target (L1). Partner hostnames superadmin-only with own-host/reserved/other-partner refusals.
- **Management API + MCP:** all 41 routes and both MCP entry kinds call `authenticateApiKey(request, "manage")`; `sk_` on manage → 403; no route reads a pid from path/query/body; every `:id` resolves inside `auth.pid`-scoped stores; `mapArguments` never maps a pid/host; `callTool` forwards only the original `Authorization`; `tools/list` carries no property data. Settings writes allowlisted (`rejectUnknown` + explicit mapping) — `stripeAccountId`, `liveBooking`, `connectedSystem`, `websiteDomain`, `partnerId`, `slug`, `public` unreachable. Team ops never write `owner`/`role`. Webhook SSRF gate on route and store; secret only in the POST response. From-address not writable. Images: `image/*`, ≤ 8 MB, UUID keys, `/images/*` served with `CSP: sandbox` + nosniff. Create-property copies owner/partner from the key property's record; no escalation.
- **Payments:** Stripe webhook HMAC + 300 s; session bind on every finalize caller (`checkout.complete`, `api.stripe-webhook` booking + voucher, `vouchers-complete`, `finalizeFromStripeSession`); Connect OAuth nonce + `canAccess` + `isOwnerOrSuper`; refunds `canManageProperty`/`ownerGate`, full-amount only, audited, Stripe-idempotent; PR 478 holds (`/v1` never charges unless `live`). Viva webhook body untrusted — finalize re-fetches with the order's property credentials and binds orderCode + status + amount/currency/mode; ISV endpoints scoped by stored `merchantId`; credentials in their own KV key, never in loader data; diagnostics contain no secrets. Price integrity: currency pinned to settings; rates/offers from catalog; occupancy capped; promo re-resolved and clamped; extras server-priced; voucher lookups pid-scoped and throttled; zero-decimal handled on both sides of the bind; finalize-once via `UNIQUE(pid, reference)`.
- **Guest surfaces:** only `dangerouslySetInnerHTML` uses are JSON-LD via `jsonLdHtml` and the regex-allowlisted font loader; rich text parses to a tree, links `https?://` only; footer/social/CTA/terms/privacy URLs `httpUrl`/`safeUrl` at write and read; image refs `/images/` only; fonts `FONT_PAIRS`; page slugs regex + reserved; room/rate translations text-only; HTML emails `esc()` every dynamic value except the write-validated brand colours. Guest cookie `httpOnly`/`Lax`/`Secure`/signed; manage-booking and manage-voucher email-ownership checks; manage login generic errors + throttle; booking refs 40 bits paired with email. Every other redirect is built from constants after property resolution or from server data. Embed postMessage checks origin, source and URL prefix.
- **Data layer:** every `.prepare(` parameterised; the only interpolations are fixed literals or `placeholders(n)`; every tenant table query binds `pid`; D1 100-param cap chunked everywhere lists are bound. `wrangler.jsonc` `vars` hold no secrets; `SESSION_SECRET` fail-closes in PROD; missing `OPEN_CHANNEL_API_KEY` → 401. XML escaping on Google feeds/ARI; SparkPost JSON API (no raw header injection); `reply_to`/`host_notify_email` regex-validated on both paths. Per-request KV cache is `AsyncLocalStorage`-scoped per `fetch`, absolute keys, no cross-tenant path.
- **Live headers:** CSP, `X-Frame-Options`, nosniff, referrer policy correct per path; CNAME target 301s to canonical; `/v1` without a key → 401; `/mcp` GET is the documented unauthenticated probe.

---

## Out of scope (as before)

Style/naming; `script-src 'unsafe-inline'` with no concrete exploit found; the racy KV `rateLimit` where it is only a throttle; pass-2 product/role decisions not re-argued.

---

## What this branch changes

| File | Why |
|---|---|
| `docs/security-review-2026-09-02.md` | This review. |
| `app/lib/properties.server.ts` | `propertyIdError`; `addProperty` refuses slug/id collisions, strangers on existing ids, and tombstoned ids; `removeProperty` tombstones. |
| `app/lib/property-delete.server.ts` | `deletePropertyForGood`: revoke keys, delete webhooks + Viva config, clear payment/live settings, then remove. |
| `app/lib/api-auth.server.ts` | `revokeAllApiKeys`; `identifyApiKey` 401s for a property no longer in the registry. |
| `app/lib/webhooks.server.ts` | `deleteAllWebhooks`. |
| `app/lib/overrides.server.ts` | `clearSettingsFields`. |
| `app/routes/admin/properties.tsx` | Custom ids superadmin-only; `addProperty` errors surfaced; delete → `deletePropertyForGood`. |
| `app/lib/https-redirect.ts`, `workers/app.ts` | HTTP → HTTPS redirect for every served hostname; HSTS on https responses. |
| `app/lib/base.ts`, `app/routes/property/contact.tsx`, `app/routes/property/manage.tsx`, `app/routes/admin/lang.tsx` | Open-redirect fixes: property resolved before any redirect; segment sanitiser; `/admin`-only lang redirect refusing `//` and `/\`. |
| `app/lib/team-invites.server.ts`, `app/routes/api.v1.manage.team.tsx`, `…team.$id.tsx`, `app/routes/admin/team.tsx`, `app/lib/email.server.ts`, `app/lib/mcp.ts`, `app/lib/openapi-manage.ts`, `docs/management-api.md`, `app/lib/admin-locales/*.ts` | API invites become owner-approved requests; owner notification email; Approve/Decline UI. |
| `app/routes/admin/connectivity.tsx` | Connect/disconnect gated on `canManageProperty`. |
| `app/lib/properties-registry.test.ts`, `app/lib/https-redirect.test.ts`, `app/lib/base.test.ts`, `app/lib/manage-team-webhooks-google.test.ts`, `app/lib/api-auth-scope.test.ts` | Pin the above. |
