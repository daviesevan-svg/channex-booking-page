# Internal booking-engine analytics

**Status: planned, not built.**

First-party funnel and conversion measurement, computed on our own servers and
shown in the admin. No third-party tags, no consent banner, and — by
construction — more accurate than anything GA4 can report.

This is the layer that serves the large majority of properties. See
[`tracking.md`](./tracking.md) for the GA4/GTM work, which answers a different
need: getting the conversion signal into ad platforms so they can optimise
bidding. The two are complements, not alternatives.

---

## 1. Why this first

- **No consent needed** (§2), so it ships without the consent-management overhead
  that stalled the GA4 plan.
- **More accurate than GA4.** The `purchase` step is logged from the
  `finalizeBooking` claim path, so it counts every booking — including the guest
  who paid and closed the Stripe tab before returning, which no client-side tag
  can ever see. No ad-blocker loss, no ITP loss, no consent-rate erosion.
- **It becomes the reconciliation baseline.** When GA4 reports 8 bookings and we
  know there were 11, that's how a broken tag gets found. Agencies never have
  this.
- The precedent already exists and works: `search_event` in
  `app/lib/search-analytics.server.ts` logs every availability search with no
  visitor identifier, fire-and-forget through `waitUntil`, pruned on cron, and
  aggregated with plain `GROUP BY`s for `/admin/analytics`.

---

## 2. The consent position

The consent trigger is **storing or reading something on the guest's device** —
that is what the ePrivacy rules govern, and what a cookie or `localStorage` does.
Store nothing on the device and that requirement does not engage. GDPR still
governs the processing, but cookieless, first-party, aggregate-only audience
measurement with no third-party sharing is the shape regulators carved out for
exactly this (CNIL's exemption for properly configured Matomo being the familiar
example).

**The rule, and it is load-bearing: never store an identifier on the device.**

The moment a `visitor_id` cookie is set, this whole document needs a consent
banner. That request will come — write the rule down and hold it.

The other half of the line: **anything that leaves our servers for an ad platform
needs consent, whether it is sent from the browser or from our backend.** Sending
a hashed email to Meta or Google is disclosing personal data to a third party for
advertising. Server-side does not dodge consent. This is the most common
misconception in this area and it is why internal analytics is genuinely
consent-free while `tracking.md` is not.

### Required: a privacy-notice line

The exemption depends on disclosure. Properties link their own policy
(`settings.privacyUrl`), so we cannot edit it — **ship paste-ready copy** in the
admin describing first-party audience measurement, retention, and that no data is
shared with third parties. Skipping this undermines the entire basis.

---

## 3. Sessionisation without device storage

The naive version — no identifier at all — can only count *requests*. A guest
reloading the results page five times counts five, so `checkout / results` is a
request ratio, not a conversion rate. That is a real methodological weakness, not
a rounding error.

**Recommended: a daily-rotating salted visit key.**

```
visit_key = sha256(daily_salt + client_ip + user_agent)   // truncated
```

- Computed server-side at log time. **The raw IP is never stored**, only the hash.
- The salt rotates every day, so a key cannot follow anyone across days — the
  identifier is deliberately short-lived by design, not by policy.
- Nothing is written to the device, so ePrivacy consent still does not engage.
  This is precisely how Plausible, Fathom and Matomo's cookieless mode operate,
  and it is well-precedented for the audience-measurement exemption.

What it buys: real unique-visit counts and true funnel conversion rates instead of
request ratios.

**Known limitation, state it in the dashboard:** guests behind the same NAT on the
same browser build — hotel wifi, corporate networks, some mobile carriers —
collapse into one key, so uniques are slightly undercounted. Fine for trends and
comparisons; not a billing-grade visitor count.

**Ceiling to be honest about:** cross-day and cross-device journeys are not
reconstructable. A guest who researches on mobile Tuesday and books on desktop
Friday is two visits. Fixing that requires a persistent identifier, which
requires consent. That is the deliberate trade.

---

## 4. Data model

A **new** `funnel_event` table. `search_event` is left alone — it is live and its
dashboard works; consolidating the two is a sensible later cleanup, not a
prerequisite.

```sql
CREATE TABLE IF NOT EXISTS funnel_event (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id  TEXT    NOT NULL,
  ts           INTEGER NOT NULL,
  visit_key    TEXT    NOT NULL,
  step         TEXT    NOT NULL,   -- results | detail | cart | checkout | purchase
  step_rank    INTEGER NOT NULL,   -- 1..5, so furthest-reached is a MAX()
  checkin      TEXT,
  checkout     TEXT,
  nights       INTEGER,
  lead_days    INTEGER,
  adults       INTEGER,
  children     INTEGER,
  rooms        INTEGER,            -- lines in the cart at this step
  room_id      TEXT,               -- detail step / single-room carts
  rate_id      TEXT,
  value        REAL,               -- checkout + purchase only
  currency     TEXT,
  country      TEXT,
  lang         TEXT,
  device       TEXT                -- "mobile" | "desktop"
);
CREATE INDEX IF NOT EXISTS funnel_event_prop_ts ON funnel_event (property_id, ts);
CREATE INDEX IF NOT EXISTS funnel_event_visit   ON funnel_event (visit_key, ts);
```

Follow `search-analytics.server.ts` exactly: idempotent `ensureSchema()`,
fire-and-forget `queueFunnelEvent()` wrapping `waitUntil`, every failure swallowed
and logged. **Analytics must never break a guest booking.**

Deliberate omissions:

- **No booking reference on the purchase row.** Reconciliation only needs counts
  and value sums over a window, and leaving it out keeps every row in the table
  unlinkable to an individual. Cheap, and it makes the privacy posture simple to
  describe.
- **No raw IP, no raw user agent.** `device` comes from the `Sec-CH-UA-Mobile`
  request header — a clean boolean, no UA string parsing, no fingerprinting.

### Log the state, not the transition

Each request logs the funnel step it *is*, with the cart size it has. There is no
add-to-cart diffing — the cart lives in the URL (`sel`), so a server request
cannot see the previous state anyway, and it does not need to. Furthest step
reached per visit is a `MAX(step_rank)` in SQL:

```sql
SELECT MAX(step_rank) AS reached
FROM funnel_event
WHERE property_id = ? AND ts >= ?
GROUP BY visit_key
```

This is simpler and more robust than event-transition tracking, and it cannot
drift out of sync with what the guest actually did.

---

## 5. Where each step is logged

| Step | Rank | Where |
| --- | --- | --- |
| `results` | 1 | `results.tsx` loader (beside the existing `queueSearchEvent`) |
| `detail` | 2 | `detail.tsx` loader |
| `cart` | 3 | any funnel loader seeing a non-empty `sel` |
| `checkout` | 4 | `checkout.tsx` loader, with `value` |
| `purchase` | 5 | **`finalizeBooking()`, inside the claim** |

That last row is the important one. `finalizeBooking` already uses
`claimBooking()` so only one caller runs the side effects when the Stripe return
races the webhook — which means single-fire is guaranteed by existing code rather
than reinvented, and it captures bookings whose confirmation page was never
rendered.

Purchases arriving via `/v1` or MCP will also be counted. That is correct for a
revenue dashboard, but it means the funnel's `purchase` count can exceed what the
web steps explain. Log the booking's channel so web and API bookings can be
separated in the dashboard rather than quietly inflating the web conversion rate.

---

## 6. D1 growth — a first-cut requirement, not a follow-up

This is the same failure shape as `ari_log` reaching 337 MB on 11 bookings.
Event-per-request logging across many properties gets expensive quickly, and
retention added after the table is large is a migration instead of a setting.

- **Never log a raw pageview.** Only the five funnel steps above.
- **Raw rows: 90 days**, pruned on the existing cron beside
  `pruneSearchEvents()`.
- **Daily rollup table** `funnel_daily (property_id, day, step, device, country,
  visits, events, value_sum)` written by the same cron and kept indefinitely — it
  is tiny, and it is what makes year-over-year trend possible without keeping raw
  rows.
- Dashboard reads rollups outside the raw window, raw rows inside it.
- Mind the **100-bound-parameter D1 cap** (`app/lib/d1-limits.ts`) if rollup
  inserts are batched.

---

## 7. Dashboard

Extends `/admin/analytics`, which already has the search-demand half. New: a
conversion tab.

- **Funnel** — visits reaching each step, with drop-off between them.
- **Conversion rate** — purchases / visits that searched, over time.
- **Searches per booking** — the most stable KPI here, because both ends are
  exact.
- **Revenue** — booked value, ADR, average length of stay, average lead time.
- **Abandoned value** — reached `checkout` with a value, no `purchase`. Directly
  actionable for a hotel.
- **By room and rate** — which rate plans get looked at versus booked. Not
  available from GA4 without custom-dimension setup.
- **By device and country** — where the funnel leaks.
- **Web versus API/agent** bookings kept separate.

---

## 8. What this cannot do

**It cannot feed ad platforms.** Google Ads and Meta need the conversion signal
inside their own systems to optimise bidding and build audiences. An accurate
internal dashboard does not help their algorithms at all. Customers running paid
campaigns still need `tracking.md`, and that should be said plainly rather than
letting this read as a substitute.

**Existing escape hatch for the few who need it now:** we already dispatch
HMAC-signed `booking.created` / `booking.cancelled` webhooks
(`app/lib/webhooks.server.ts`). Any agency with middleware can forward those to
Meta's Conversions API today with no work from us — subject to the consent point
in §2, since that is personal data going to an ad platform.

---

## 9. PR sequence

1. `funnel_event` schema + `queueFunnelEvent()` + the visit-key hash + unit tests
   on the key and the rollup SQL.
2. Log the five steps, `purchase` first (it is the highest-value, lowest-volume
   one, and it can be verified against real bookings immediately).
3. Cron: prune + daily rollup. **Before** meaningful volume accumulates.
4. Dashboard conversion tab.
5. Privacy-notice copy in the admin.

---

## 10. Open questions

- **Salt storage and rotation.** A daily salt must be generated, stored, and
  rotated somewhere (KV, keyed by date). Yesterday's salt is needed briefly at a
  day boundary for late-arriving writes; simplest is to derive the salt from a
  long-lived secret plus the UTC date, so nothing needs storing at all.
- **Does `visit_key` belong in the rollup?** No — rollups should store counts
  only, so the identifier disappears entirely after 90 days.
- **Bot filtering.** Crawlers hitting `/rooms` will inflate step 1 and depress
  conversion. Cloudflare's bot score is available on the request and is the cheap
  answer; without it the funnel's top is measurably wrong.
