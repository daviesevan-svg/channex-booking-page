# Security review — 2026-08-22 pass 2

Second-pass review of [channex-booking-page](https://github.com/daviesevan-svg/channex-booking-page) on `main` at `32e6824` (PR 477 merged). This pass re-read current main; it does not assume the first review’s leftover list is still true.

**Scope:** regressions in PRs 471–477; every admin loader/action for partner isolation; MCP and `/v1`; guest surfaces; ari-proxy, webhooks, feeds, image/R2, Scrapfly; the new CSP. Style nits, `unsafe-inline` CSP without a concrete exploit, and the known racy KV `rateLimit` (except where it is used as a money/inventory latch) are out of scope.

**Fix shipped with this review:** one high-confidence money bug — `POST /v1/bookings` / MCP `create_booking` opened a real Stripe or Viva session for bookings that only finalize as `simulated`. Hosted checkout already refused that. See finding **H1**.

Do not merge other work from this document unless a later pass treats it as the same bar.

---

## Executive summary

PRs 471–477 hold up. Stripe session bind, Connect OAuth nonce, admin login same-copy, image-import allowlist, HTML `frame-ancestors`, web checkout fingerprint, uncarded-agent `claimWindow`, and the superadmin D1 claim are implemented on the write paths they claim, with tests.

Cross-partner admin isolation is sound: sessions are host-bound, `getVisibleProperties` / `canAccess` / `currentPropertyId` are the chokepoints, and booking/voucher/key lookups bind `(propertyId, id)`. MCP and `/v1` keys are property-scoped; there is no `pid` override and no cancel/refund on the public API.

One new high-confidence money bug: **test (and other simulated) API bookings still charged the hotel’s live connected account**. That is the only change in this branch.

Everything else below is residual risk, completeness, or product-role gaps — documented, not patched.

---

## Findings

### High

#### H1 — `/v1` and MCP charge real money for simulated bookings

**Status: fixed in this branch.**

**Evidence.** Hosted checkout already documents the rule and enforces it:

```493:500:app/routes/property/checkout.tsx
  // Only take a real payment in LIVE mode. In test mode the booking is
  // simulated and pushed nowhere, so charging would take money for a booking
  // that isn't created — skip the gateway entirely and fall through to the
  // simulated finalize below.
  if (live && dueAfterVoucher > 0 && !gateway) return { paymentError: "not_connected" as const };
  const goesToGateway = Boolean(live && gateway && (dueAfterVoucher > 0 || gateway.kind === "stripe"));
```

Voucher purchase does the same (`voucher-buy.tsx` issues a simulated voucher in test mode and never opens Stripe).

`POST /v1/bookings` computed `live` for the Channex push only (`api.v1.bookings.tsx`, `live = mode === "live" && settings.liveBooking && channex`). The Stripe and Viva branches then ran whenever a gateway was connected, with **no** `live` / `mode` check. Sessions are direct charges on the hotel’s connected account (`stripe.server.ts` `Stripe-Account` header; Viva merchant credentials from `activeGateway`). MCP `create_booking` dispatches in-process to this same action (`mcp.tsx`).

Operator copy and the public spec say the opposite: admin “A **test** key creates simulated bookings”; OpenAPI “`sk_test_…` for simulated bookings”; property test mode “no payment is taken” (`admin-locales/en.ts`).

**Impact.** A holder of `sk_test_…` — or a live key on a property with live bookings off — could hand a guest a real `payment_url`, collect a live charge or a live guarantee card, then finalize `status: "simulated"` with no channel-manager reservation. The guest paid for a stay that was never created.

**Fix applied.** `apiBookingChargePath()` (`app/lib/api-booking-charge.ts`) is the same decision as `goesToGateway`. Simulated bookings (`live === false`) skip the gateway and finalize unpaid. Covered by `api-booking-charge.test.ts`. Wired in `app/routes/api.v1.bookings.tsx`.

---

### Medium

#### M1 — Simulated bookings still decrement local ARI, email, and fire webhooks

**Evidence.** `finalizeBooking` gates only the Channex push on `live`. Any non-failed status (including `simulated`) then:

```347:350:app/lib/booking-finalize.server.ts
    await decrementAvailability(pid, stayAvailabilityItems(...));
    await sendBookingEmails(pid, record, origin);
    await dispatchWebhook(pid, "booking.created", serializeBooking(record), Date.now());
```

PR 472’s comment that test keys “can’t consume the inventory this protects” refers to Channex, not the local ARI cache. A burst of test-key (or web test-mode) bookings can take rooms off sale on the engine until the next Channex push, send real guest/host mail, and hit configured endpoints.

**Not fixed here.** Integrators may rely on webhook/email side effects for sandboxing. Gating them is a product change, not a one-line money bug.

**Recommended fix (later).** Gate `decrementAvailability` / `sendBookingEmails` / `dispatchWebhook` on `live`, or stamp `simulated` on the event and document it. If emails stay, skip inventory at least.

#### M2 — Web uncarded live bookings have no D1 `claimWindow`

**Evidence.** API live uncarded path is 1/hour per key (`api.v1.bookings.tsx` `claimWindow('apibook_nocard:${pid}:${auth.keyId}', 3600)`). Hosted checkout can finalize without a card on the same conditions (Viva / no gateway, nothing due) at `checkout.tsx` ~630, with only the KV `rateLimit` 10 / 10 min (`book:${pid}:${clientKey}`).

**Not fixed here.** Different threat model (anonymous guest vs agent key eating inventory). The KV limiter is the known racy throttle; it is not used as a hard 1-per-hour latch.

**Recommended fix (later).** If the hotel-facing risk is the same, add `claimWindow(\`webbook_nocard:${pid}:${clientKey(request)}\`, 3600)` on the uncarded finalize branch before `finalizeBooking`.

#### M3 — Adults cap of 25 is only on the URL reader

**Evidence.** `readOccupancy` clamps `MAX_ADULTS = 25` (`occupancy.ts`). `GET /v1/availability` uses `Math.max(1, parseInt(...))` with no ceiling (`api.v1.availability.tsx:21`). `POST /v1/bookings` is `z.number().int().positive()` (`api.v1.bookings.tsx`). `go.booking.tsx` parses `adults` uncapped (then `readOccupancy` clamps on the next page). Cart `sel` parse does not clamp.

**Mitigation.** `resolveCartByOccupancy` clamps to room capacity; checkout refuses a cart that does not cover the party. Remaining risk is expensive catalog/ARI work from a huge `adults` on `/v1/availability` — the self-DoS PR 475 targeted for query params.

**Recommended fix (later).** Export `MAX_ADULTS` and apply it on the API and cart parse paths.

#### M4 — Manual “Add property” does not stamp `partnerId`

**Evidence.** `admin/properties.tsx` `intent === "add"` calls `addProperty(id, name, email)` with no partner. Onboard-channex and booking-import stamp `user.partnerId`. `getPublicProperties` lists `public && !partnerId`.

**Impact.** A `partner_admin` can create a direct (unbranded) property they still see via `owner === email`. If they mark it public, it can appear on Roompanda’s public picker — partner-brand isolation, not a cross-tenant data IDOR.

**Recommended fix (later).** Stamp `partnerId` from `getUser(email)` on add (and on clone, if the source is partner-scoped).

#### M5 — Confirmation page renders success without a booking

**Evidence.** `property/confirmation.tsx` loader never calls `getBooking`. It rebuilds the stay from query params and always shows the success chrome unless `?status=failed`. Anyone can open `/…/confirmation/FAKEREF?checkin=…` and get a plausible confirmation screen.

**Impact.** Integrity / social-engineering, not data IDOR. The reference alone cannot manage or cancel (guest email session required).

**Recommended fix (later).** Require a short-lived signed token or a real `getBooking` hit before showing success.

#### M6 — `partner_admin` is not a manager in `isOwnerOrSuper`

**Evidence.** `isOwnerOrSuper` is owner or superadmin only (`properties.server.ts`). Used for team, API keys, webhooks, refunds, Google save, voucher comp/refund, widget theme. `partner_admin` sees every `partnerId` property but cannot operate those controls on hotels they do not personally own.

**Not a cross-partner leak.** Authorization-model / ops gap.

**Recommended fix (later).** Document as intentional, or add `canManageProperty` that includes `partner_admin` when `user.partnerId === property.partnerId`.

#### M7 — Same-tenant: teammates can change payments and go-live settings

**Evidence (no owner gate):**

| Action | File |
|---|---|
| Connect / disconnect Stripe or Viva | `admin/payments.tsx` action |
| Toggle live booking / slug | `admin/general.tsx` |
| Toggle public listing | `admin/property.tsx` |
| Portal auto-refund | `admin/portal.tsx` |

Member-area hiding is optional and does not apply to `partner_admin`. API keys, webhooks, team, and refunds *do* use `isOwnerOrSuper`.

**Impact.** Same-tenant privilege, not cross-partner. A teammate who can open Payments can attach their own Stripe account or store Viva credentials for that property.

**Recommended fix (later).** If Payments should be owner-only, gate it with `isOwnerOrSuper` (or the extended manager helper). Same for live-booking / public / auto-refund if those are meant to be owner controls.

---

### Low

| ID | Finding | Evidence | Recommended fix |
|---|---|---|---|
| L1 | Viva finalize does not check `merchantTrns === ref` | `paymentFromVivaTransaction` checks `statusId === "F"` and `orderCode` only (`booking-finalize.server.ts`). Orders are created with `merchantTrns: reference`. | After lookup, require `String(tx.merchantTrns ?? "") === order.ref`. Defense in depth; order-code mapping is the bind. |
| L2 | Checkout intent claimed before the rate limit | `resolveWebCheckoutIntent` then `rateLimit` (`checkout.tsx`). A 429 leaves the fingerprint bound to a reference with no pending for up to 3h. | Rate-limit first, or `releaseCheckoutIntent` on 429. |
| L3 | `claimWindow` / checkout-idem fail open without D1 | `rate-limit.server.ts`, `checkout-idem.server.ts`. Fine for local; production should always have D1. | Log/alert if D1 is missing when these latches are required. |
| L4 | MCP `initialize` / `tools/list` / `GET /mcp` are unauthenticated | `mcp.tsx`. Tool *execution* still requires a key via `/v1`. Canonical host only. | Optional: require auth for `tools/call` at the MCP layer; rate-limit the probe. |
| L5 | `scrapeUrl()` has no allowlist of its own | `scrapfly.server.ts` forwards any URL to Scrapfly. Sole caller is admin-only `normalizeBookingUrl` → `*.booking.com/hotel/…`. | Enforce the host allowlist inside `scrapeUrl`. |
| L6 | Channex ARI inbound has no replay window | Static `api-key` header, timing-safe compare (`ari/ingest.server.ts`). Replay requires the platform key. | Dedup on Channex event id / timestamp if the payload has one. |
| L7 | Review submit is unthrottled | `property/review.tsx`. Booking UUID is the credential; unlimited edits are intentional. | Per-IP / per-booking limit if spam becomes a problem. |
| L8 | Invalid custom theme colors pass into embed CSS | `accessible-accent.ts` — non-hex values skip sanitization and land in `color-mix(...)`. Admin-only. | Reject anything not `/^#[0-9a-f]{3,6}$/i`. |
| L9 | `admin/lang.tsx` has no `requireAdmin` | Sets a UI language cookie only. | Add `requireAdmin` for consistency. |
| L10 | `/embed/*` is globally frameable | Intentional (`html-security-headers.ts`). Widget has no payment UI. | None. |

---

## Hardening PRs 471–477 — verified, not re-litigated

### PR 471 — Stripe session bind

`assertSessionMatchesPending` fail-closes on `client_reference_id`, `metadata.pid`, mode, amount, currency (`stripe-session-bind.ts`). Last-line `assertCollectedPayment` in `finalizeBooking`. Callers: `checkout.complete.tsx`, `api.stripe-webhook.tsx` (booking + voucher), `vouchers-complete.tsx`, `finalizeFromStripeSession`. Unbound sessions are not refunded (would steal another guest’s payment). Amount/currency mismatch auto-refunds. Tests cover the swap.

Viva uses a parallel bind: order-code stash → transaction re-fetch → `orderCode` + `statusId === "F"` + `assertCollectedPayment`. See L1.

### PR 472 — Uncarded agent 1/hour D1 claim

`claimWindow` is D1 `INSERT … ON CONFLICT DO NOTHING` plus steal-after-expiry (`rate-limit.server.ts`). On the no-gateway / Viva-nothing-due finalize path only, live keys only. MCP uses the same action. Test keys exempt by design (they no longer charge — H1). Admin onboard-booking is an import, not this path.

### PR 473 — Stripe Connect OAuth session nonce

256-bit nonce, not a property UUID (`stripe-connect-state.ts`). Stamped on Connect click; consumed once (`auth.server.ts`). Timing-safe compare. Callback uses session property + `canAccess`, never `state` as a UUID. Denied OAuth still consumes the nonce.

### PR 474 — Admin login + voucher-buy throttle

Same public copy for allowed and unknown emails (`admin-login.ts`; `allowed` unused). Timing-safe HMAC on the session (`auth.server.ts`). Magic `jti` single-use in KV. `sendMagicLink` logs email only, not the URL. IP + email throttle before the allow check. Verify is host-bound. Voucher-buy throttle is on session mint only; complete/webhook are idempotent + session-bound.

### PR 475 — Adults cap, image-import allowlist, superadmin claim

`readOccupancy` clamps 25 (see M3). `importImageFromUrl` allowlists `https` + `*.bstatic.com`, no creds, no odd ports, re-checks each of ≤3 redirects. Gallery is upload-only; clone copies R2 keys; scrape import goes through the helper. `claimSuperadminIfUnclaimed` is D1 fail-closed, canonical host only.

### PR 476 — HTML security headers

Applied only from `entry.server.tsx` (document renderer). Path-scoped:

| Path | `frame-ancestors` | `X-Frame-Options` |
|---|---|---|
| `/admin` | `'none'` | DENY |
| `/embed` | `*` | omitted |
| else | `'self'` | SAMEORIGIN |

Prefix-safe (`/administration`, `/embedder` → `'self'`). `form-action` includes `https://*.stripe.com` and `https://*.vivapayments.com` so Chrome can follow the POST→302 onto hosted checkout / Connect. No `frame-src` for Stripe/Viva (payments are top-level). `unsafe-inline` is documented; no exploit found. Partner custom domains use the same pathname rules — `/admin` on a partner admin host is still `'none'`.

### PR 477 — Web checkout idempotency

Fingerprint is SHA-256 of canonical stay + guest + cart (`checkout-idem.ts`). Amounts omitted on purpose (reprice must not mint a second stay). Property UUID scoped. Two different stays do not collide. Replaying someone else’s fingerprint requires the same stay + email + name + phone + cart — that *is* the same intent and correctly returns the same reference / payment URL. PII is in the hash input only; KV stores `{reference, url}`. Cancelled/failed bookings are not reused. See L2 for rate-limit ordering.

---

## Admin / partner isolation

Every admin route under `app/routes/admin/` was read (loader and action).

**Cross-partner: a partner A admin cannot,** via admin routes alone:

- Switch the session to a partner B property (`canAccess` ∩ `getVisibleProperties`)
- Read B’s bookings, vouchers, emails, or API keys (`getBooking(propertyId, id)` and friends)
- Complete Stripe OAuth for a property they cannot access (`payments.callback` + `canAccess`)
- List or edit partners/users (`requireSuperadmin`)
- Escalate to superadmin via team invite (invite does not overwrite `partnerId`; `claimSuperadminIfUnclaimed` is canonical-host + D1)
- Sign in on partner B’s admin host without a user bound to B (`canSignInOnHost`)

**Hidden nav vs loader.** The six `PageId`s (`connectivity`, `api-keys`, `webhooks`, `google-hotels`, `brand-kit`, `collections`) call `requirePageAllowed` in the loader (and action where there is one). API keys / webhooks / team enforce `isOwnerOrSuper`. Users / partners enforce `requireSuperadmin`. Member hidden areas go through `currentPropertyId` → `assertMemberAreaAllowed`.

**`select-property` open redirect.** `redirectTo` must start with `/admin` (`select-property.tsx`).

Residual same-tenant issues: M4, M6, M7.

---

## MCP and `/v1`

| Check | Verdict |
|---|---|
| Auth | Bearer `sk_live_` / `sk_test_` only. HMAC-hashed, reverse index, revocation deletes the index. Canonical host. |
| Property scope | `pid` from the key. No body/query override. `GET /v1/properties/:id` 403s a mismatched id. Catalog and bookings all use `auth.pid`. |
| Cross-property room/rate ids | Resolved against `auth.pid` catalog; foreign UUIDs fail availability. |
| Booking IDOR | `getBooking(auth.pid, id)` / `getBookingByReference`. Pending fallback checks `pending.pid === auth.pid`. |
| Cancel / refund | Not on `/v1` or MCP. Admin UI and guest manage-booking only. |
| Test vs live (Channex) | Test keys never push. |
| Test vs live (money) | **Was broken (H1); now matches hosted checkout.** |
| Uncarded ceiling | `claimWindow` on live keys only; MCP shares the path. |
| Idempotency | `idem:${pid}:${key}` — cannot cross properties. |
| Key privilege | Property-scoped only. No partner/superadmin API keys. |

Channex `api.changes` / `api.mapping_details` / `api.test_connection` use the platform `openChannelApiKey`, not per-property keys. Compromise of that key is a separate trust model.

---

## Guest surfaces

| Surface | Verdict |
|---|---|
| Manage booking | `ownedBooking()` requires guest-session email == booking email; cancel re-checks. |
| Manage login | Reference + email, generic errors, 8/10 min IP throttle. Redirects are hardcoded paths. |
| Manage voucher | Buyer email + `lookupVoucherGuarded`. |
| Tokens | Booking refs: 8× base32 via `crypto.getRandomValues` (~40 bits). Voucher codes: `RP-XXXX-XXXX`. Review/manage ids: `crypto.randomUUID()`. |
| PII in URLs | Confirmation carries stay/cart, not name/email/phone. |
| Open redirects | Guest session targets are fixed paths. Viva return/failure go to property-scoped checkout/confirmation. `go.booking` unknown hotels → fixed Channex URL; known hotels → `/${channelId}/rooms` with validated dates. |
| Cross-property voucher | All ops scoped to `resolveRequestProperty()`; D1 PK is `(pid, code)`. Partner guest hosts refuse another partner’s slug. |
| Embed | No user HTML. `embed.js` only follows `roompanda:navigate` when the URL is `ORIGIN + "/"`. Parent checks `e.origin === ORIGIN`. Framing is intentional. |
| Guest cookie | `httpOnly`, `SameSite=Lax`, `Secure` on HTTPS, signed. |
| JSON-LD XSS | `jsonLdHtml` escapes `<` / U+2028 / U+2029. `rich-text.tsx` forbids `dangerouslySetInnerHTML`. |

See M5, L7, L8.

---

## Webhooks, ari-proxy, feeds, image/R2, Scrapfly

| Area | Verdict |
|---|---|
| Stripe webhook | HMAC + 300s timestamp. Bind + claim. Replay of another session cannot finalize this pending. |
| Viva webhook | No signature (Viva). Finalize re-fetches the transaction with merchant OAuth and checks `statusId` + `orderCode`. Return URL `?t=` is not trusted alone. |
| Roompanda outbound | Secret shown once; list is `whsec_…` + last 4. HMAC over `t.body`. `isSafeWebhookUrl` requires HTTPS and blocks private / `.local` / `.internal`; `fetch` is `redirect: "manual"`. |
| ari-proxy | Caddy allows only `POST /travel/hotels/uploads/*` with `X-Ari-Proxy-Key`, strips the key, IPv4-only dial. Key is server-side only. |
| Channex inbound | Timing-safe platform key. See L6. |
| Image route | R2 by opaque UUID; no upstream fetch. `?w=` allowlisted. Response CSP `sandbox` + nosniff. |
| Image import | Allowlist inside the helper (PR 475). |
| Feeds | Public on the canonical host by design (Google pull). `requireCanonicalHost` so they are not served from a hotel domain. |
| Scrapfly | Admin-only; URL normalized before scrape. See L5. |

---

## Still fine

- Stripe session cannot be swapped onto a different pending (bind + last-line payment assert).
- Connect OAuth `state` is a one-time session nonce; a property UUID in `state` does not attach Stripe.
- Admin login does not enumerate operators; magic URLs are not logged.
- Superadmin bootstrap is a D1 singleton; fail-closed without D1.
- Image import cannot fetch metadata IPs or arbitrary HTTPS.
- Admin pages are not frameable; guest checkout is same-origin only; embed is intentionally frameable and has no card UI.
- Checkout fingerprints do not collide across stays; a third party cannot replay another guest’s intent without the same stay + identity + cart.
- Partner A cannot read or mutate partner B’s property, keys, payments, team, or bookings through admin, `/v1`, or MCP.
- Guest manage-booking / manage-voucher are email-session IDORs, not “know the UUID”.
- Outbound hotel webhooks and image import are not Worker-side SSRF.
- Viva and Stripe return URLs do not take an open redirect target.

---

## Out of scope (as requested)

- Style / naming.
- `script-src 'unsafe-inline'` without a concrete exploit.
- Racy KV `rateLimit` used as a blunt throttle (admin login, voucher-buy, contact, manage lookup, web checkout 10/10 min). Not used as a hard inventory or money latch except where `claimWindow` already replaced it.
- Leftover items from pass 1 that are still product/role decisions (M6, M7) — recorded, not re-argued as merge-blocking.

---

## What this branch changes

| File | Why |
|---|---|
| `docs/security-review-2026-08-22-pass2.md` | This review. |
| `app/lib/api-booking-charge.ts` | Single payment-routing decision for `/v1` / MCP. |
| `app/lib/api-booking-charge.test.ts` | Pins “simulated ⇒ no gateway”. |
| `app/routes/api.v1.bookings.tsx` | Uses that decision instead of charging whenever a gateway exists. |
