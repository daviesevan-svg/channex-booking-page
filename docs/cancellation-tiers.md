# Multi-tier cancellation

A cancellation policy with more than one step: free, then a partial refund,
then nothing.

The guiding constraint: **a booking carries its own refund schedule, resolved
to instants and amounts at booking time.** Nothing downstream — the manage
page, the refund, the email, the PDF — re-derives a deadline or a percentage
from the rate. That is already how the single deadline works
(`CancellationSnapshot`); this extends the snapshot rather than replacing the
idea.

> **Status (2026-09-07): scoping only.** Nothing here is built. §6 lists the
> decisions that need an answer before phase 1 starts.

---

## 1. Why

A customer's required direct/Google policy (Sept 2026):

- 100% refund when cancelled 14 or more days before check-in.
- 50% refund when cancelled 7–13 days before check-in.
- Non-refundable when cancelled 0–6 days before check-in.
- No-shows owe the full total.

| Wanted | Today |
|---|---|
| Three bands | `CancellationRules.tiers` is an array (`rate-policy.ts`), but every consumer reads `tiers[0]`: the rate editor writes exactly one (`admin/rate.tsx:55`), and the copy, checkout and resolver read index 0 (`policy-copy.ts:35`, `checkout.tsx:950`, `policy.server.ts:108`). A second tier sent through `PUT /v1/manage/rates` is stored, echoed back, and ignored everywhere the guest looks. |
| A 50% refund | The snapshot is binary — `{ refundable, cancelByISO }` (`policy.server.ts:7`). Refunds are all-or-nothing: `refundBookingCharge` takes an `amountMinor` (`refunds.server.ts:23`) that no caller passes. Guest self-cancel refunds in full (`manage-booking.tsx:124`); the admin button refunds in full (`admin/booking.tsx:149`). |
| Cancel at day 10 | Self-cancel is blocked past the free deadline (`manage-booking.tsx:58`). The guest contacts the hotel; the hotel refunds by hand in Stripe or Viva. |
| Google sees the policy | Not published in the Hotel List feed or the JSON-LD (`hotel-jsonld.server.ts`). Separate gap, not addressed here. |

The workaround today — free until 14 days, non-refundable after, and the full
three-band wording in the rate's `overrideNote` — shows the guest the right
words. It does not compute the right refund, and the day-10 guest cannot
cancel without emailing the hotel.

---

## 2. What a tier already means

No model change is needed, only agreement on what the array means.

`CancelTier = { deadlineValue, deadlineUnit, penalty, penaltyValue? }` reads:
*free to cancel until this far before arrival; after it, `penalty` applies.*
With several tiers, ordered most generous first, `tiers[i].penalty` applies
from `tiers[i]`'s deadline until `tiers[i+1]`'s, and the last tier's penalty
runs to arrival. The customer's policy is two tiers:

```ts
tiers: [
  { deadlineValue: 14, deadlineUnit: "days", penalty: "percent", penaltyValue: 50 },
  { deadlineValue: 7,  deadlineUnit: "days", penalty: "full_stay" },
]
noShow: { penalty: "full_stay" }
```

Consequences that fall out for free:

- `tiers[0].deadline` is still the end of the free window, so the legacy
  mirrors (`refundable`, `cancelDeadlineValue/Unit`) stay correct as written
  by `admin/rate.tsx:271` and `applyPolicyMirrors` (`manage-validate.ts:975`).
  Everything that reads them — `/v1/rates.free_cancel_until`, the detail rate
  card's `freeCancelUntilISO` (`catalog.server.ts:517`), Google ARI's
  `refundable` — is unaffected.
- A one-tier rate behaves exactly as today. Existing data needs no migration.
- Every deadline is anchored the same way: counted back from
  `settings.cancelAnchorTime` (default 18:00) in the property's timezone on
  the arrival date (`cancelDeadline()` in `dates.ts`). "14 days" is 18:00
  fourteen days before arrival. See §6.1.

---

## 3. Design

### 3.1 The snapshot: bands

`CancellationSnapshot` (`policy.server.ts:7`) gains one field and keeps the
rest:

```ts
interface CancellationSnapshot {
  refundable: boolean;
  cancelByISO: string | null;     // UNCHANGED: end of the free window
  cancelByLocal?: string;
  /** Ordered, most generous first. Cancelling before `untilISO` earns `refund`.
   *  After the last band: nothing. Absent on bookings made before this shipped
   *  — one free band ending at cancelByISO, then nothing. */
  bands?: CancelBand[];
}
interface CancelBand {
  untilISO: string;
  untilLocal: string;
  penalty: PenaltyType;
  penaltyValue?: number;
  /** Major units, computed at booking time from the stay total and the amount
   *  actually charged. This is the number the refund path uses. */
  refund: number;
}
```

`cancelByISO` keeps its meaning so all seven existing readers keep working
untouched until they are upgraded (§4). A booking from before this shipped has
no `bands` and is read as a single free band — which is what it was.

Resolved at booking time by `resolveBookingCancellation`, which switches from
the legacy mirrors to `ratePolicyOf(rate).cancellation.tiers`. The mirrors are
kept in sync so the answer for tier 0 is identical; the property-level default
deadline (`settings.cancelDeadlineValue`, read at `policy.server.ts:50`) has no
tier form and stays as the fallback single free band for a rate with no tiers.

### 3.2 Refund arithmetic

Penalties are stated against the **stay total** (`booking.total`); refunds come
out of the **amount actually charged** (`payment.amount`).

```
penalty(band) = none → 0 | percent p → total·p/100 | fixed f → f
              | first_night → total/nights | full_stay → total
refund(band)  = clamp(charged − penalty, 0, charged)
```

So a 30% deposit with a 50% penalty refunds nothing; full prepayment with a 50%
penalty refunds half. Pay-at-hotel bookings (`payment.mode === "setup"`) have
`charged = 0` and every band's `refund` is 0 — the bands are still stored, and
shown, because the copy is the promise.

Minor units only through `toStripeMinor(amount, currency)` /
`toVivaMinor` (`money.ts:193`, `viva.server.ts`). Never `× 100`: the charge
factor is not the display decimals (UGX, ISK, JPY).

### 3.3 Mixed carts

Today `resolveBookingPolicy` picks the harsher tier 0 across rates
(`policy.server.ts:108`) and `cancellationVaries` makes checkout say "varies by
room" when refundability differs. With bands, the merged schedule is the
**pointwise minimum**: take the union of every rate's band boundaries and, in
each interval, the lowest refund any rate offers. Conservative, honest, and a
single schedule the snapshot can hold. Per-room refund schedules on a mixed
cart are out of scope (§7).

### 3.4 Guest self-cancel inside a penalty band

Today: past the free deadline the button is disabled and the hotel is
contacted. Proposed: a guest may self-cancel in any band whose `refund > 0`,
after a confirmation that names the numbers — *"You paid £600. Cancelling now
refunds £300."* The last band (refund 0) keeps today's behaviour: disabled,
"contact the hotel". That leaves non-refundable handling exactly where it is
and only opens the middle bands, which is the whole point of having them.

The server re-check at `manage-booking.tsx:100` computes the band at action
time from the snapshot — the page's number is never trusted. With
`settings.autoRefund` on, the cancel action passes `band.refund` to
`refundBookingCharge` as `amountMinor`; off, the hotel refunds manually and the
admin booking page shows the policy amount (§4).

### 3.5 Validation

Enforced in the rate editor and in `manage-validate.ts:265` (which today
accepts any array in any order):

- deadlines strictly decreasing along the array (each tier is closer to
  arrival than the last);
- refund non-increasing: a later band may not be more generous;
- `percent` in 1–100; `fixed` ≥ 0; `penaltyValue` required for those two;
- at most, say, four tiers — enough for any hotel policy, and the rate editor
  has to render it.

---

## 4. Touch points

Everything that reads a cancellation policy or moves refund money. Line
numbers as of `29dac16`.

| Area | File | Today | Change |
|---|---|---|---|
| Model | `lib/rate-policy.ts` | array, comment says "single tier ships" | comment only; `describePolicy` (170) renders N bands |
| Resolver | `lib/policy.server.ts` 31–73 | legacy mirrors → binary | `ratePolicyOf` tiers → bands; §3.2 arithmetic; §3.3 merge in `resolveBookingPolicy` (99) |
| Copy | `lib/policy-copy.ts` 29–47 | `tiers[0]` → `CancellationLike` | returns bands too |
| View | `lib/cancellation.ts` | `CancelView` 4 kinds, `CancelMessage` 4 keys | new kinds `partialUntil` / `partialFromNow`; new keys |
| Snapshot | `lib/booking-create.server.ts:181` | binary | bands stored |
| Record | `lib/bookings.server.ts:84` | `cancellation?: CancellationSnapshot` | type only |
| Rate editor | `routes/admin/rate.tsx` 46–80, 176, 271, 298–305, 620–680 | one tier's fields | repeatable tier rows, add/remove, live `describePolicy` preview, §3.5 messages; admin i18n × 6 |
| Checkout | `routes/property/checkout.tsx` 194–197, 935–955 | free-until + `latePhrase` from tier 0 | full schedule; consent via `consentGate` |
| Consent | `lib/checkout-totals.ts:86` | `nonRefundable` = no free window | `nonRefundable` = no refund at all; new `partialFromNow` ack when the free window has closed but a paying band is open |
| Rate card | `routes/property/detail.tsx` 223–237 | free-until line | keep; optionally one more line, see §6.4 |
| Manage booking | `routes/property/manage-booking.tsx` 51–61, 100, 122–126, 159–164, 168 | gate on `cancelByISO`; full refund | §3.4 gate, confirmation with amounts, `amountMinor` to refund; tooltip copy |
| Admin booking | `routes/admin/booking.tsx` 143–158, 199, 510–535 | full refund; binary line | schedule shown; "policy refund now: £X"; partial amount input (owner/manager), pre-filled |
| Refund | `lib/refunds.server.ts` 20–84 | `amountMinor` accepted, never passed | unchanged; callers pass it. Single-refund latch unchanged (§7) |
| Gateways | `lib/stripe.server.ts:302`, `lib/viva.server.ts:275` | partial supported in the signature | Viva partial to be proven in sandbox (§8) |
| Email | `lib/email-render.server.ts` 194–204 | binary line | band-aware line; `{refund_amount}` (104) already carries a partial |
| PDF | `lib/booking-pdf.server.ts` 206–214 | binary line | band-aware line |
| Guest i18n | `lib/locales/*.ts` × 10 | 6 penalty keys exist in all 10 | ~4 new keys × 10 |
| API validate | `lib/manage-validate.ts` 265–280, 975 | any array accepted | §3.5 ordering; mirrors unchanged |
| API serialize | `lib/api-serialize.ts` 174, 179, 237, 320 | `cancellation: {refundable, cancel_by}` | `+ bands[]` on bookings; `policyMap` follows `describePolicy` |
| API create | `routes/api.v1.bookings.tsx` 264–275 | `describePolicy` for consent text | follows |
| OpenAPI / MCP | `lib/openapi-manage.ts:195`, `lib/mcp.ts:362` | tiers documented as array | descriptions; ordering rule |
| Webhooks | `booking.cancelled` via `serializeBooking` | `refunded.amount` already present | `bands` ride along |
| Docs | `docs/management-api.md` | — | rate policy row; refunds stay UI-only (line 27) |

Not touched: `dates.ts` (`cancelDeadline` is already the one implementation),
the Channex push, Google feeds, the legacy mirrors.

---

## 5. Phasing

**Phase 1 — express and show it.** No money moves differently. Ships the
customer's policy in the guest's own words on every surface, and a
policy-computed refund figure on the admin booking page for the hotel to act
on by hand.

1. Resolver + snapshot + arithmetic + merge, with tests (`policy.server.ts`,
   `policy-copy.ts`, `booking-create`).
2. Rate editor N tiers + validation + admin i18n; API validation ordering;
   OpenAPI/MCP descriptions.
3. Copy: `describePolicy`, `cancellation.ts` kinds, guest i18n × 10; the
   seven display sites; consent gate.
4. API/webhook serialization + docs.

**Phase 2 — enforce it.**

5. Guest self-cancel in a paying band with confirmation; `autoRefund` passes
   the band amount.
6. Admin partial refund (amount input, pre-filled from policy, owner/manager
   gated, once per booking).
7. Viva partial refund proven in sandbox; cancellation email refund sentence
   across 10 languages.

Rough size: phase 1 is the bulk — four PRs, the rate editor being the
largest. Phase 2 is three smaller PRs but carries the money risk. Nothing
needs a migration or a schema change.

---

## 6. Decisions needed

1. **Where does "14 days before check-in" fall?** Our deadlines count back
   from the property's cut-off time (default 18:00). "14 days" = 18:00 on
   day −14. The customer's wording reads as calendar days: anywhere on
   day −14 or earlier. Options: they set `cancelAnchorTime` to 23:59 (then
   "14 days" is the end of day −14); or we accept the 18:00 reading and say so
   in the copy, which `describeDeadline` already does ("18:00, 14 days before
   arrival"). Recommend: ask the customer, default to the copy being explicit.
2. **Self-cancel in a paying band** (§3.4). Recommend yes with the
   amounts-in-the-confirmation step; the alternative leaves the tiers as copy
   only. The 0% band stays hotel-handled.
3. **Penalty base.** Stay total (§3.2), or the amount charged? Stay total is
   what hotels mean by "50% of the reservation"; the deposit case then refunds
   nothing, which is correct and should be shown as such at checkout.
4. **Rate card depth.** One line ("Free cancellation until …") as today, or
   add "partial refund until …"? Recommend one line on the card, the full
   schedule at checkout, where the guest commits.
5. **Admin partial refund** in phase 2 — an amount field, or only the policy
   figure? Recommend the field, pre-filled, ≤ charged, once (§7).

---

## 7. Out of scope

- **More than one refund per booking.** `payment.refund` is a single slot and
  the claim latch (`refund-claim.server.ts`) is one key per booking. A partial
  refund followed by a top-up needs a refund list; not needed for this policy.
- **Charging a penalty or no-show fee** against a guarantee card
  (`mode: "setup"`). Nothing charges today; a 100%-refund-before-deadline
  policy on a pay-at-hotel rate still refunds nothing because nothing was
  taken. No-show stays copy.
- **Publishing the policy to Google.** Neither feed nor JSON-LD carries it.
- **Per-room schedules on a mixed cart.** Pointwise minimum (§3.3) instead.
- **Refund verbs on the management API.** Money actions stay UI-only
  (`management-api.md` §"Money actions").
- **Per-extra refund rules.** Extras follow the booking.

---

## 8. Sharp edges

- **Money is in minor units and the factor is not the display decimals.**
  Every amount to a gateway goes through `toStripeMinor` / `toVivaMinor`. A
  50% refund of a JPY or UGX booking is where `× 100` bites.
- **Old snapshots.** Email, PDF and admin read bookings made months ago.
  `cancelByISO` keeps its meaning and `bands` is optional so nothing
  re-renders differently until upgraded; the fallback is one free band.
- **The action decides, not the page.** `manage-booking` must compute the
  band at submit time from the snapshot and pass that amount — a guest with a
  stale tab open across a band boundary gets the band they are actually in.
- **Refund amount before the claim.** The amount is decided, then the latch
  is taken, then the gateway is called — a retry after a failed gateway call
  recomputes and may land in a later band. Acceptable and honest; note it in
  the log line.
- **Viva partial refunds are unproven.** `vivaRefund` sends `?amount=`, and
  the real sandbox payment loop has never been run end to end
  (`project_channex_viva_payments`). Phase 2 needs that before a partial
  amount goes to Viva in production.
- **Zero is meaningful** at every parse on the way in (PR389): a tier with
  `deadlineValue: 0` is "until 18:00 on arrival day", not "unset". The rate
  editor's repeatable rows must keep `nonNegInt` + the empty-string check.
- **Boundary inclusivity.** A cancellation at exactly `untilISO` is inside the
  band (`now <= until`). One rule, used by the gate, the copy and the tests.

---

## 9. Tests

Unit, against the pure helpers:

- band resolution: hours and days, the 18:00 anchor across a timezone, `0`,
  a free window that closed before booking (already non-refundable), order.
- arithmetic: each penalty type; deposit clamp to zero; full prepay; JPY and
  UGX through the minor-unit helpers; `charged = 0`.
- merge: two rates with different schedules → pointwise minimum; one
  non-refundable rate → all zero; identical rates → unchanged.
- validation: out-of-order deadlines, a more generous later band, `percent`
  101, missing `penaltyValue`, tier cap.
- copy: `describePolicy` for one, two and three tiers; `cancellationMessage`
  kinds and keys; the override note still replaces the lot.
- back-compat: a snapshot without `bands` renders and gates exactly as today.

Route-level, against the real modules with the D1 shim (as
`refund-once.test.ts`):

- guest cancel in a paying band → `refundBookingCharge` called once with the
  band's `amountMinor`; in the last band → refused; before the free deadline →
  full amount, unchanged.
- admin partial refund → gated to owner/manager, once, `≤ charged`.
