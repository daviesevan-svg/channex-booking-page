# Google Ads account link (paid Hotel campaigns from the hotel's own account)

A hotel can run **paid Google Hotel campaigns** for its property, landing on its
booking pages here, **from its own Google Ads account**. Google's rule: a Hotel
campaign needs a **Hotel Center account** (the one holding the property's prices
and landing pages — ours) **linked to the advertiser's Google Ads account**. The
link can be scoped to a list of hotel ids, so the hotel sees and bids on exactly
its property, nothing else in our feed. Spend, bidding and campaign management
stay entirely in their Google Ads account; the landing page comes from our
Hotel Center Points of Sale and cannot be changed from Google Ads.

## What the admin page does

`/admin/google-hotels` → **Google Ads** section (Hotel Center program only;
owner/manager). The hotel pastes its 10-digit Google Ads customer id
(`123-456-7890`, the advertising account — not a manager/MCC account).

0. **Gate:** the property must be **on Google** first. The cached Travel Partner
   match status (`google:match:{id}`, refreshed by the cron) must not read
   `not_found` / `not_matched` / `overlap`; `matched` passes, and so does a
   never-checked or unrecognised status (fail-open, like the ARI push gate — the
   check is best-effort and must not lock an owner out). The page hides the form
   and the action refuses in the same states (`blockedByMatchState`).
1. **Link** → `POST accounts/{hotelCenter}/accountLinks` with
   `googleAdsCustomerName: customers/{id}` and
   `accountLinkTarget.hotelList.partnerHotelIds: [propertyId]`
   (the hotel id is the property id — the same key as the feed, JSON-LD and ARI).
   Google answers with the link's resource name and status
   `REQUESTED_FROM_HOTEL_CENTER`.
2. The hotel **approves in Google Ads**: Tools → Data manager → Google Hotel
   Center → accept the request from our Hotel Center account (admin access to the
   Ads account required). Google says allow up to 72 h before the Hotel campaign
   type appears.
3. **Check status** (button) / the 6-hourly cron (`refreshPendingGoogleAdsLinks`)
   re-reads the link: pending links every run, approved ones ~daily. `APPROVED`
   unlocks campaigns. A 404, or our hotel id missing from the list, means the link
   was removed on Google's side and our record is cleared.
4. **Unlink** → PATCH this hotel off the list when the customer's other
   properties stay linked, DELETE the link when it was the last one.

Module: `app/lib/google-ari/account-link.server.ts` (calls) +
`account-link.ts` (pure helpers, stored-record type). Tests:
`account-link.test.ts`.

## Storage

- `SiteSettings.googleAdsLink` — `{ customerId, name, status, createdAt, checkedAt }`
  per property (written with `patchSettings`, cleared with `clearSettingsFields`).
- KV `google:adslink:{customerId}` → link resource name. Needed because Google
  enforces **one link per (Hotel Center account, Ads customer)** and a link does
  **not** report its Ads customer id, so a second property of the same hotel
  group must find and extend the existing link (PATCH `updateMask=accountLink.account_link_target`)
  instead of tripping `ALREADY_EXISTS`.

## Auth and permissions

Same service account + Travel Partner API scope as the match-status check
(`docs/google-property-status.md`): `GOOGLE_TRAVELPARTNER_ACCOUNT_ID`,
`GOOGLE_TRAVELPARTNER_SA_EMAIL`, `GOOGLE_TRAVELPARTNER_SA_PRIVATE_KEY`
(Cloudflare dashboard secrets; not in `.dev.vars`, so locally the section shows
"not configured"). Google's help says adding an account link needs **Owner**
permission in Hotel Center. The service account has so far only been used to
read hotel views; if it lacks Owner, the first Link attempt fails with a 403 and
the admin page shows a message saying so — grant the role in Hotel Center →
Users and retry. Nothing on our side caches the failure.

## Not covered

- Commission bidding (pay-per-stay / pay-per-conversion) is a partner-level
  Google program for "select partners" and is not offered; hotels use CPC,
  Enhanced CPC or target ROAS.
- The management API / MCP do not expose the link yet.
- Linking initiated from the Google Ads side (`REQUESTED_FROM_GOOGLE_ADS`) still
  needs a Hotel Center owner to approve by hand; the UI shows that state but the
  page cannot approve it.

References: [Travel Partner API accountLinks](https://developers.google.com/hotels/hotel-prices/api-reference/rest/v3/accounts.accountLinks),
[Product Linking: Hotel Center and Google Ads](https://support.google.com/hotelprices/answer/7663773),
[About Hotel campaigns](https://support.google.com/google-ads/answer/9238461).
