# Analytics & conversion tracking

**Status: planned, not built.** This is the agreed design for GA4 + Google Tag
Manager support, captured so it can be picked up later.

Asked for by a marketing agency managing several hotel clients: they need to
measure booking-engine performance and attribute reservations to Google and Meta
campaigns, with booking value, currency, reservation id, dates, nights and rooms
reaching the tracking layer. The comparison point is WebHotelier, which exposes a
tab per platform (Analytics, Tag Manager, Google Ads, Facebook Ads, Sojern) plus
two free-form code boxes.

---

## 1. Scope

**GA4 and GTM only.** Not Meta Pixel, not Google Ads, not Sojern — and not
because they don't matter.

The guiding constraint: **the product is the event contract, not the
integrations.** A GTM container plus a well-designed dataLayer lets any customer
wire Meta, Google Ads, Sojern or anything else themselves, in the tool their
agency already lives in, on the day we ship. Every platform we integrate by hand
is one we then own forever; every platform they wire in GTM costs us nothing.

So the per-platform tabs are deliberately not built. The agency's original ask is
still answered in full — it's answered through their container instead of through
our code.

Both a GA4 Measurement ID field and a GTM Container ID field ship, not one. GTM
is the strategic half, but a plain `G-` ID is a few lines once the dataLayer
exists, and without it we only serve agency-managed hotels. Independent
properties have a Measurement ID and nothing else.

---

## 2. The one architectural decision

**Loaders build the payload. The client only pushes it.**

The cart lives in the URL (`sel` param, `app/lib/cart.ts`), and every funnel
loader already resolves it server-side with real prices via
`resolveCartByOccupancy` + `computePricing`. So the payload is built where the
money math already happens.

No pricing logic in the browser, no second implementation to drift from the
first, no gap between what the guest is charged and what GA4 is told. This is the
decision that keeps the rest of the work small.

---

## 3. Event contract

One canonical contract, GA4-standard event names so both delivery routes work
natively. No compatibility aliases for other engines' variable names — one clean
contract, documented in-app on the settings page.

GA4 has no native hotel dimensions, so stay attributes ride as custom event
parameters. **The docs must tell the customer to register them as custom
dimensions in GA4**, or they will be collected and invisible.

| Route | Event | Payload source |
| --- | --- | --- |
| every guest route | `page_view` | route change (virtual) |
| `/rooms` | `view_item_list` | results loader |
| `/rooms/:roomId` | `view_item` | detail loader |
| `sel` gains a line | `add_to_cart` | loader diff |
| `sel` loses a line | `remove_from_cart` | loader diff |
| `/checkout` | `begin_checkout` | checkout loader |
| `/confirmation/:ref` | `purchase` | `BookingRecord` |

### The cart diff

`add_to_cart` has no click handler to hang off — the guest navigates with a
changed `sel` param. Diff the previous `sel` against the current one on route
change and emit the delta.

Better than instrumenting buttons: it catches every path into the cart including
deep links, and there is one implementation instead of one per button. Guard on a
previous `sel` being known in-session, so arriving on a shared link with three
rooms already selected doesn't report three adds.

### Purchase payload

```
event: "purchase"
ecommerce: {
  transaction_id: reference       // BookingRecord.reference
  value:          grandTotal      // incl. tax, fees, extras — matches Stripe
  currency:       currency
  tax:            sum(pricing.taxLines)
  items: [ { item_id: roomId, item_name: roomTitle,
             item_variant: rateTitle, price: room.total, quantity: 1 } ]
}
nights, checkin, checkout, rooms, adults, children,
lead_days, room_subtotal, extras_total, due_now, balance_due,
promo_code, property_id, payment_type
```

Decisions taken rather than exposed as settings:

- **`value` is the grand total** — the figure that reconciles against Stripe and
  the one ROAS is computed from. Components ship as separate parameters
  (`room_subtotal`, `extras_total`, `tax`, `due_now`), so anyone wanting a
  different basis computes it in GTM. Better than a config option: no ambiguity,
  no support burden, all the raw material present.
- **`quantity: 1`, `price` = the room's stay total.** The alternative (nightly
  rate × nights) introduces rounding drift so item revenue stops summing to the
  transaction total. `nights` is a top-level parameter anyway.
- **`payment_type`** separates a captured payment from a guarantee card
  (`payment.mode === "setup"`), and `due_now` / `balance_due` come from
  `dueNow(policy, grandTotal, nights)`. A hotel taking a 30% deposit can then
  reconcile GA4 revenue against Stripe deposits without us guessing which they
  meant.
- **`purchase` does not fire when `status === "failed"`.** The confirmation page
  already branches on this; a refunded failure is not revenue.

---

## 4. Data model

```ts
// SiteSettings (app/lib/content.ts)
analytics?: {
  ga4MeasurementIds?: string[];   // /^G-[A-Z0-9]{4,}$/
  gtmContainerId?: string;        // /^GTM-[A-Z0-9]{4,}$/
}
```

Validated on save, rejected with a field error rather than silently dropped.

A **"paste your snippet" extractor** pulls the ID out of a pasted `gtag`/GTM
block and discards the rest. Worth copying from WebHotelier — it's a real
affordance, and it doubles as the validation boundary: parse a known shape,
extract the ID, reject everything else. Never store the pasted blob.

Multiple GA4 IDs, one per line. Hotel-plus-agency dual tagging is the normal
case, not an edge case.

---

## 5. Files

**New**

- `app/lib/tracking.ts` — pure payload builders: `purchaseEvent(record, settings)`,
  `viewItemListEvent(...)`, `cartDelta(prevSel, nextSel, resolved)`. No DOM, no
  globals, unit-testable. All the correctness risk concentrates here, which is
  why it's pure.
- `app/lib/tracking-settings.server.ts` — validation + `patchSettings` wrapper.
- `app/components/tracking-scripts.tsx` — creates `window.dataLayer`, loads
  GTM/gtag after hydration. Renders `null` when unconfigured.
- `app/components/tracking-events.tsx` — `<TrackingEvents payload={…} />`, pushes
  on mount, dedupes by key.
- `app/routes/admin/tracking.tsx` — the two fields plus the contract docs.

**Touched**

- `app/routes/property/layout.tsx` — mount `<TrackingScripts>`; add `analytics`
  to loader data. This layout is mounted twice (`/:channelId` and custom-domain
  root, `app/routes.ts:177` and `:192`) and wraps every guest route — marketing
  pages, funnel, confirmation. One component covers both mounts, and the embed
  iframe tree is separate, so it stays untagged by construction rather than by
  remembering to exclude it.
- `results.tsx`, `detail.tsx`, `checkout.tsx` — each loader returns a `tracking`
  payload.
- `confirmation.tsx` — load the `BookingRecord` by reference; build the payload
  from it. See below.
- `app/routes.ts` — the admin route.

---

## 6. Four correctness mechanisms

Not polish. Each one produces confidently wrong data if skipped, which is worse
than no data.

### Purchase must read the booking record

`confirmation.tsx` recomputes the entire price from URL query params and never
loads the `BookingRecord`. Emitting revenue from that means **a guest editing the
URL changes reported revenue**, and any drift from what Stripe actually captured
shows up as wrong revenue in GA4.

Add `getBookingByReference(pid, ref)` and build the payload from it. The page's
*displayed* prices can stay as they are — this is the analytics payload only, so
it's additive with no visual risk.

### SPA pageviews

We are React Router with client-side transitions. GTM's auto-pageview does not
fire on them. Initialise with `send_page_view: false` and push a virtual
`page_view` on every `useLocation()` change.

Without this, only the landing page is ever recorded. This is exactly the failure
WebHotelier papers over with *"never enable Google Analytics via the Tag Manager,
it will break the page and you will lose data"* — getting it right is a visible
capability win over the tool these customers are comparing us to.

### Fire-once on purchase

The confirmation page is refreshable and bookmarkable. `sessionStorage` key
`rp_purchase_<reference>`, checked before pushing. Survives refresh and
back-navigation; per-tab scoping is correct, since a genuine second booking has a
different reference.

### Click-ID capture

Capture `gclid` / `fbclid` / `utm_*` at first landing onto the booking record.
A few lines, unused in this phase — but **unrecoverable if not collected now**.
It is the prerequisite for Google Ads offline conversion import later.

---

## 7. Consent — deliberately not built

**Decision (Aug 2026): no consent banner.** Managing consent UI was judged not
worth the overhead right now.

What was specced and set aside: a two-toggle banner (Analytics →
`analytics_storage`; Advertising → `ad_storage` + `ad_user_data` +
`ad_personalization`), Accept / Configure buttons, a preference centre, a
versioned + timestamped first-party `rp_consent` cookie read server-side, a
permanent "Cookie settings" footer entry for withdrawal, and an EEA/UK/CH geo
gate off Cloudflare's country. Roughly 60 locale strings across the 10 guest
languages — it was the largest single chunk of the phase, ahead of the tracking
itself.

**How to ship without it.** Consent becomes the customer's responsibility, which
is a legitimate architecture — most hotels with a marketing site already run a
CMP (Cookiebot, OneTrust, Osano), and every major CMP drives Consent Mode
natively. The clean version is one per-property switch:

- *Consent handled externally* — we emit Consent Mode defaults **denied** and the
  hotel's own CMP grants. Correct for any property that has a CMP.
- *No consent management* — tags fire immediately; the hotel carries the legal
  responsibility.

That is a setting, not a form to manage. The trap to avoid is defaulting to
denied with no CMP present: GA4 then never fires and the customer reports
"tracking is broken".

Consequence to state plainly to customers rather than discover: without a banner
or a CMP, EU traffic is being tracked without consent. That is the hotel's
exposure, not ours, but it should be said out loud in the settings copy so nobody
believes we handled it for them.

### What a denial actually costs

Asked by the first German customer, and the answer people assume is wrong: a
guest who declines is **not** measurable in Google Ads. Not "degraded" —
unattributable. Worth writing down because every plan for this feature founders
on someone believing there is a way around it.

**Implement Consent Mode in *advanced* mode, not basic.** Basic = no tag loads
until consent, so a denial sends nothing at all. Advanced = the tag loads with
all four signals defaulted to denied and still fires at confirmation, as a
cookieless ping: no `_gcl_aw`, no gclid read back, no identifier of any kind.
Google learns that a conversion of value X happened on this domain and has no
way to join it to a click. Advanced is strictly more than basic for the same
compliance posture, so there is no reason to build basic.

**Modelling is Google's answer and it does not apply at hotel scale.** Those
cookieless pings are meant to become modelled conversions, inferred from the
behaviour of consented users. Modelling only switches on above a volume
threshold — Google's documented bar has been on the order of 700 ad clicks per
day, per country, per domain grouping, sustained over a week. One property
bidding on its own name is nowhere near that, so a small hotel gets neither
observed nor modelled conversions from the guests who declined. **Re-check the
current threshold in Google's own documentation before quoting it to a
customer**; Google moves these numbers and this one dates from Aug 2026.

**Server-side does not dodge it, and this is the trap.** The gclid arrives in
the landing URL, so we can carry it through the funnel and upload the conversion
from the Worker without ever touching the device. That clears § 25 TDDDG, which
governs reading and writing on the device and nothing else. It does not clear
the second rule: a gclid is an online identifier, and sending it to Google for
advertising needs a GDPR legal basis, which Google's own EU user consent policy
then requires to be consent for `ad_user_data` / `ad_personalization`. Two
separate rules; the reflex is to notice the first, satisfy it, and ship. See
also §11 *Server-side conversions* — Measurement Protocol changes the delivery
path, not the permission.

**Capture the gclid regardless** (§6, Click-ID capture). It has to survive the
Stripe redirect for the *granted* case to work at all, and it is unrecoverable
if not collected at landing. Storing it against the booking for the hotel's own
measurement is a different question from sending it to Google, with a different
answer.

**What survives a denial** is our own funnel: `funnel_event` in D1, keyed by a
cookieless daily hash, measures every booking whether or not a tag ever fired.
That is the hotel's source of truth for conversion rate and abandoned value. It
cannot feed Google's bidding, which is the part that is genuinely lost.

**What to tell the customer**, in these words: you will measure your consented
traffic, which on a competent German banner is most of it, and the rest is a gap
nobody can close for you. It is the same gap on WebHotelier, on any CMP, and on
any other IBE — so it is not a reason to stay where they are. Said up front it
is a known limitation; discovered in month two when our numbers disagree with
Google Ads, it reads as a broken integration.

---

## 8. Performance

Third-party JS on pages tuned in PRs 336–342.

- Nothing injected for unconfigured properties — they pay zero bytes.
- `dataLayer` array created synchronously so no event is lost; the container
  requested after hydration.
- `preconnect` to `googletagmanager.com` only when configured.
- Measure Lighthouse mobile on results and checkout, tagged vs untagged, and
  record the delta rather than assuming it's zero.

---

## 9. Verification

Not "it looks wired up":

1. GA4 **DebugView** with a real test-mode booking end-to-end — assert every
   event arrives in order with correct values.
2. **Tag Assistant** for the GTM container.
3. `purchase.value` cross-checked against the Stripe dashboard amount for that
   booking, and against `BookingRecord.payment.amount`.
4. Refresh the confirmation page five times; confirm exactly one `purchase`.
5. Navigate the whole funnel client-side; confirm one `page_view` per step, not
   one for the session.
6. Unit tests on `tracking.ts` for the payload builders and the `sel` diff.

Assert on what GA4 actually received in DebugView — not on the presence of a
script tag in the HTML.

---

## 10. PR sequence

1. Settings model + validation + `/admin/tracking` + docs (nothing observable,
   zero risk).
2. `app/lib/tracking.ts` + unit tests.
3. `<TrackingScripts>` + the consent posture switch from §7.
4. `purchase` end-to-end, including the `confirmation.tsx` record load.
   **Verify in DebugView here**, before any funnel breadth is built on top.
5. Remaining funnel events + the `sel` diff.

---

## 11. Deferred, with consequences

**Cross-domain attribution.** If marketing is on `hotel.com` and booking on
`book.roompanda.com`, GA4 treats the hop as a new session and attributes **every
booking to `referral / hotel.com` instead of the campaign that paid for it**.
Fine while customers are on custom domains or our website templates, where
marketing and funnel share an origin and the problem doesn't exist. The first
customer running WordPress on a separate domain needs: a linker across both
domains, plus an audit that `go/booking` and the embed's `roompanda:navigate`
relay stop stripping query params. This is the most expensive silent failure in
the feature.

**Server-side conversions.** Client-side only means bookings where the guest
closes the Stripe tab after paying, blocks scripts, or is cut by ITP are missing:
the webhook finalizes them but no event fires. It recovers those, and *only*
those — a guest who declined consent stays unmeasurable however the event is
delivered (§7, *What a denial actually costs*). The fix is GA4 Measurement
Protocol off the existing `claimBooking` exactly-once path in
`booking-finalize.server.ts` — which already guarantees single-fire for Channex
pushes and emails, so dedupe is solved by existing code. Needs a `source` field
on the booking so `/v1` and MCP bookings don't fire web conversions. Not needed
while client-side only, which is a genuine saving from the scope cut.

**Refund and cancellation events.** Without them, reported ROAS is permanently
inflated by bookings that never happened. This is the clearest differentiator
over WebHotelier, whose model is client-side only.

**Voucher purchases.** A real revenue stream (`/vouchers/complete`) that will be
untracked. Stated so it's a known gap rather than a discovery.

**Meta Pixel / Google Ads / Sojern fields.** Available to customers through GTM
from day one. Only worth building natively if customers without GTM keep asking.
