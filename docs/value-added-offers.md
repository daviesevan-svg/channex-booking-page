# Value-added offers

An offer that gives the guest **more**, not cheaper.

The guiding constraint: **a value-add is not a discount with a value of zero.**
Money and inclusions are different things, so they get different fields, and
every existing `value > 0` guard keeps meaning what it means today.

---

## 1. Why

A customer (Hotelier101, Aug 2026) wanted a direct-only package: three nights,
Thursday to Sunday, no discount — welcome drink and dinner on arrival, a full
brunch instead of breakfast on the checkout day, late checkout at 3pm.

Two separate things stop that today:

| Wanted | Today |
|---|---|
| An offer with no discount | `DiscountType` is `"percent" \| "fixed"`; `resolveAppliedPromo` drops a result when `discount <= 0`; `offerMatches` rejects `value <= 0`; `isPublishedOffer` requires `value > 0` |
| "Arrive on a Thursday" | `PromoConditions` has lead time, `minNights` and a date window. No day-of-week rule anywhere |

The workaround is a dedicated rate plan with `inclusions` plus two passes of the
inventory bulk update (min-stay on Thursdays, closed-to-arrival on the other
six). It works, but: it's invisible on the offers page, the inclusions never
reach the confirmation, it needs a duplicate rate per package, and it is
**impossible on a channel-managed property** because the inventory grid is
read-only property-wide (`inventory.tsx` action, `isChannexConnected`).

Day-of-week conditions are worth having on their own. "Sunday-night special",
"midweek only", "weekend arrivals" are all ordinary hotel offers that no amount
of `minNights` can express.

---

## 2. Model

`app/lib/promotions.ts`.

### 2.1 A promotion gains a kind

```ts
/** What the guest gets. Absent = "discount" — every promotion written before
 *  this field existed is a discount, and the reader must not have to care. */
export type PromoKind = "discount" | "value_add";

export interface Promotion {
  // …unchanged…
  kind?: PromoKind;
  /** What's included, one line each. Guest-facing, localized by the hotel
   *  writing it (like `name`). Only read for kind: "value_add". */
  inclusions?: string[];
  /** Don't combine with automatic discounts. See §3.2. */
  exclusive?: boolean;
}
```

`type` and `value` stay exactly as they are and stay **required**, because they
are what a discount is. For a value-add they are ignored; the admin writes
`type: "percent", value: 0` so a stored record is never half-typed.

Why a separate `kind` rather than a third `DiscountType`: `type` feeds
`computeDiscount`, the checkout summary, the booking snapshot, the API and the
Google feed. Adding a member that isn't a discount type would put a
`type === "value_add"` branch in every one of them. `kind` keeps the money path
untouched and confines the new behaviour to the places that actually differ.

### 2.2 Day-of-week conditions

```ts
export interface PromoConditions {
  // …unchanged…
  /** Check-in must fall on one of these weekdays. 0 = Sunday … 6 = Saturday,
   *  matching Date.getUTCDay(). Absent or empty = any day. */
  arrivalDays?: number[];
  /** Check-out must fall on one of these weekdays. Same encoding. */
  departureDays?: number[];
}
```

Available to **both** kinds. A percent discount for Sunday arrivals is a normal
thing to want and costs nothing extra here.

Encoding: `getUTCDay()` numbers, not names. Every date in this module is a
`YYYY-MM-DD` the hotel typed or we derived from one, compared lexically and
parsed as UTC (see `shiftISO`) — weekday extraction has to use the same clock or
a Sunday arrival in a UTC-negative timezone reads as Saturday.

João's package is then: `minNights: 3`, `arrivalDays: [4]`. Three nights from a
Thursday lands on Sunday, so `departureDays` is not needed — but a hotel that
wants to say it explicitly can.

---

## 3. Matching and resolution

### 3.1 `offerMatches`

Drop the `type !== "percent" || value <= 0` bail and gate on kind instead:

```ts
if (!p.enabled || p.trigger !== "auto") return false;
if (kindOf(p) === "discount" && (p.type !== "percent" || p.value <= 0)) return false;
if (kindOf(p) === "value_add" && !p.inclusions?.length) return false;
```

A value-add with nothing in it is not an offer — same reasoning as a 0% discount.

Then the two new condition checks, using the stay's dates:

```ts
if (c.arrivalDays?.length && (!ctx.checkin || !c.arrivalDays.includes(dowOf(ctx.checkin)))) return false;
if (c.departureDays?.length && (!ctx.checkout || !c.departureDays.includes(dowOf(ctx.checkout)))) return false;
```

Unknown dates mean the rule can't be verified, so the offer doesn't apply —
the same call the existing date-window checks make.

### 3.2 Discounts and value-adds don't compete

`bestAutoOffer` currently returns the single highest-percent match. It keeps
doing exactly that, for discounts only:

```ts
export function bestAutoOffer(promos, ctx): Promotion | null   // discounts only
export function matchingValueAdds(promos, ctx): Promotion[]    // all matches
```

A stay can therefore carry one discount **and** its value-adds at the same time.
They're orthogonal: one changes the price, the other changes what's in the room.

**Except when the hotel says otherwise.** Stacking is the default, but a hotel
running an early bird alongside a "no discount, you get dinner" package usually
means one or the other. `exclusive` on a value-add makes `bestAutoOffer` return
null when that value-add matches — the package IS the offer. Off by default, so
the common case stays zero-config. A discount CODE the guest types still applies:
refusing it needs an error state at checkout and copy in ten languages, which is
a bigger change than this flag deserves.

Why *all* matching value-adds rather than the "best" one: there is no ordering.
A welcome drink is not more or less than a late checkout, so any tie-break would
be arbitrary. A hotel that creates two overlapping value-adds means both, and
the alternative — silently dropping one — is the kind of thing nobody notices
until a guest asks where their dinner is. Dedupe identical inclusion lines
across offers so two packages that both promise breakfast say it once.

### 3.3 `isPublishedOffer`

```ts
return p.enabled && (kindOf(p) === "value_add" ? !!p.inclusions?.length : p.value > 0)
  && (p.publish ?? p.trigger === "auto");
```

### 3.4 Codes are phase 2

Phase 1 is `trigger: "auto"` only. A code-triggered value-add needs
`resolveAppliedPromo` to return a promo with `discount: 0`, and every caller of
that (the checkout summary's discount row, `computePricing`, the totals) assumes
a returned promo moves money. Untangling that is real work for a case nobody has
asked for. The admin hides the kind selector when `trigger === "code"`.

---

## 4. Guest-facing surfaces

### 4.1 Rate plans

`RatePlan` (`app/lib/channex/types.ts`) gains a sibling to `offer`:

```ts
/** Value-added offers that apply to this stay. Price is unaffected — these are
 *  inclusions, so they sit alongside `offer`, not inside it. */
valueAdds?: { name: string; inclusions: string[] }[];
```

`getCatalogRooms` (`catalog.server.ts:291`) already computes the `StayContext`
for `bestAutoOffer`; it calls `matchingValueAdds` with the same context and
attaches the result at `:413`, next to `offer`.

Do **not** merge value-add inclusions into `RatePlan.inclusions`. That field is
the rate's own admin content override, edited per rate and shown as "In this
room"; a stay-level offer arriving in it would look like the hotel had edited the
rate, and would be wrong the moment the same rate is searched for other dates.

### 4.2 Where they show

| Surface | Today | Change |
|---|---|---|
| Results card (`results.tsx:331`) | `offer.name · −N%` badge | a neutral badge per value-add, no percent, no struck price |
| Room detail body (`detail.tsx:538`) | rate `inclusions` list | a second list, labelled with the offer name, below the rate's own |

Value-adds are **stay-level**, so every rate plan carries the same list. Render
them once per results card (read off the cheapest rate) and once in the detail
body — not per rate row, which would print the same three lines under each of a
room's rates.
| Offers page (`offers.tsx`) | discount offers | value-adds too, ranked live-first as now |
| Offer page (`offer.tsx`) | headline discount + calendar | headline is the inclusion list; calendar respects `arrivalDays` |

The badge must not borrow the discount styling. A `−10%` badge and an "includes
dinner" badge look the same at a glance and one of them is a price claim.

### 4.3 The offer page calendar

`offerWindow` gains `arrivalDays` awareness: `earliestCheckin` advances to the
first matching weekday on or after the current floor, and the "can this ever
qualify again" check accounts for it.

`useDateRange` (`offer.tsx:96`) gains an `arrivalDays` option that disables
non-matching arrival dates, the same way `closedDates` already does. Without it
the calendar would offer a Tuesday, the guest would pick it, and the offer would
silently not apply — the exact trap `latestCheckin` exists to prevent.

`OfferView` echoes `conditions`, so the page renderer needs to write the new
rules as sentences: "Arrive on a Thursday", "Thursday to Sunday" when both are
set and the nights line up. Weekday names come from the guest locale
(`tr.locale`, date-fns), not a hardcoded table.

---

## 5. After the booking

### 5.1 Snapshot

`AppliedPromo` is the discount snapshot and stays that. Value-adds are a
separate field on the booking, because there can be several and they carry no
money:

```ts
// bookings.server.ts
promo?: AppliedPromo;
valueAdds?: { name: string; inclusions: string[] }[];
```

Snapshotted at creation (`booking-create.server.ts:166`) from the same
resolution the guest saw, not recomputed later. A booking is a record of what
was promised; re-deriving it would quietly rewrite history the first time the
hotel edits the offer.

### 5.2 Confirmation email and PDF

Both currently print `rateTitle` and nothing about inclusions
(`email-render.server.ts:146`, `booking-pdf.server.ts:142`). Add an "Included"
block listing the snapshotted value-adds, after the room lines and before the
totals. This is the half of the customer's request the rate-plan workaround
cannot do at all, and it's the half that matters at 6pm on arrival day when
reception is asked about the dinner.

Email templates are AI-safe and hotel-editable — the block renders from the
snapshot, not from a token the hotel could delete.

### 5.3 API

`api-serialize.ts` already emits rate `inclusions` at `:178` and `:250`. Add
`valueAdds` to the rate-plan and booking projections and to `openapi.ts`. Nothing
about `/v1` pricing changes, which is the point: an agent reading the feed sees
the same money and a richer description.

---

## 6. Admin

`/admin/promotions` (`admin/promotions.tsx`).

A **kind** selector at the top of the form, above `type`/`value`:

- **Discount** — today's form, unchanged.
- **Included extras** — hides `type`/`value`, shows a textarea of inclusions
  (one per line, same convention as the rate editor's `inclusions` field at
  `admin/rate.tsx:540`) and requires at least one non-blank line.

Both kinds get the conditions block, which gains a seven-checkbox weekday row
for arrival and another for departure — the same control the inventory bulk
update already uses for days of week (`admin/inventory.tsx:481`), so it reads as
the same idea in both places.

The list view shows the kind, and shows inclusions count instead of a percent for
a value-add. "0%" in the offers list would read as a broken discount.

---

## 7. i18n

New guest strings (10 locales, `app/lib/locales/*.ts`): the "Included" heading
for the email/PDF/detail block, "Arrive on {days}", "Leave on {days}", and a
joiner for weekday lists. Weekday **names** come from date-fns via `tr.locale` —
do not add 70 day-name strings.

New admin strings (6 locales, `admin-i18n.ts`): kind labels, the inclusions field
label and hint, the two weekday row labels. Remember the fan-out check: same EN
value ⇒ same translation.

---

## 8. Back-compat

- `kind` absent ⇒ `"discount"`. One helper, `kindOf(p)`, used everywhere; no
  migration, no rewrite of stored KV.
- `arrivalDays`/`departureDays` absent or empty ⇒ any day. An empty array must
  mean "any", not "none": a hotel that ticks all seven boxes and then unticks
  them has expressed no preference, and "none" would silently kill the offer.
- Every existing `value > 0` guard is left alone. A value-add reaches those
  paths only through the new `kind` branches.

---

## 9. Decisions worth re-reading

**Why not a free extra?** Extras reject a price of 0 or less
(`admin/extras.tsx:145`) and have no date, weekday or arrival/departure
targeting. Making them free *and* date-scoped is a bigger change to a model
that's about upsell, and it would put the package in the guest's hands to
un-tick.

**Why not a rate plan flag?** Because the constraint is about the *stay*
(3 nights, arriving Thursday), not the rate. Expressing it per rate means
duplicating every rate the package should apply to, and it needs the inventory
grid — unavailable on a channel-managed property.

**Why does this work when the workaround doesn't?** Promotions live in KV per
property and are evaluated at search time from the stay dates. They never touch
ARI, so a channel-managed property can have them.

---

## 10. Out of scope

- Code-triggered value-adds (§3.4).
- Per-rate or per-room scoping of a value-add. `Extra.excludeRates` is the
  precedent if it's wanted later; nobody has asked.
- Anything that charges for the inclusions. A value-add is free by definition;
  a paid package is a voucher (`project_channex_vouchers`) or an extra.
- Pushing value-adds to Channex or the Google feed. Both are price/availability
  channels; the inclusions are direct-only, which is the whole point.

---

## 11. Build order

| # | Step | Files |
|---|---|---|
| 1 | `kind`, `inclusions`, `arrivalDays`, `departureDays`, `kindOf`, `offerMatches`, `matchingValueAdds`, `isPublishedOffer`, `publicOffers` | `promotions.ts` |
| 2 | Admin form + list | `admin/promotions.tsx`, `admin-i18n.ts` |
| 3 | Attach to rate plans | `catalog.server.ts`, `channex/types.ts` |
| 4 | Badges + detail block | `results.tsx`, `detail.tsx` |
| 5 | Offers list + offer page + calendar weekdays | `offers.tsx`, `offer.tsx`, `use-date-range`, `promotions.ts` (`offerWindow`) |
| 6 | Snapshot, email, PDF, API | `booking-create.server.ts`, `bookings.server.ts`, `email-render.server.ts`, `booking-pdf.server.ts`, `api-serialize.ts`, `openapi.ts` |
| 7 | Guest locales | `locales/*.ts` |

Steps 1–2 are shippable on their own (a hotel can create the offer; nothing shows
it yet), and 1–5 deliver João's case end to end. Step 6 is what makes it survive
past checkout.

### Verification

Not "the badge appears". Assert on the resolution and the snapshot:

- `offerMatches` truth table over `arrivalDays`/`departureDays` × known and
  unknown dates, including the empty-array case.
- A stay that qualifies for a discount **and** a value-add carries both, with the
  price reflecting only the discount.
- Two overlapping value-adds: both apply, duplicate inclusion lines collapse.
- The offer page calendar refuses a non-matching weekday — driven by clicking the
  day, not by reading the class list.
- Book the qualifying stay and read the **stored booking row** for `valueAdds`,
  then the rendered email HTML for the Included block. Then edit the offer and
  re-read the same booking: unchanged.
