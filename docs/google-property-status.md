# Google property-match status (Travel Partner API) — future integration

Goal: before we push rooms/rates/availability (ARI) straight to Google, confirm
Google has actually **loaded and matched** the property — otherwise the push has
nothing to attach to. This is a planned integration; nothing is wired yet.

## The API

**Travel Partner API** — `accounts.hotelViews.list`
`GET https://travelpartner.googleapis.com/v3/accounts/{ACCOUNT_ID}/hotelViews`

- **Reports per-property status.** Filterable by `hotelId`, `matchStatus`
  (`NOT_MATCHED` | `MATCHED` | `MAP_OVERLAP`), and `liveOnGoogle` (`TRUE`/`FALSE`).
- Reference: https://developers.google.com/hotels/hotel-prices/api-reference/rest/v3/accounts.hotelViews/list

### What "loaded & ready for a rooms/rates push" means

- **`matchStatus == MATCHED`** → Google has ingested + matched the property from
  the Hotel List Feed / property data. **This is the readiness gate for ARI.**
  ARI can be pushed *before* the property is turned on for display.
- `liveOnGoogle` → separate on/off for *displaying* the property. Not required
  to accept ARI (you can push prices before going live), so it's informational,
  not a push gate.
- `NOT_MATCHED` → Google hasn't matched it yet (feed not ingested, or address/geo
  mismatch). Pushing ARI now is wasted.

Our hotel id in the feed is the property id (`getProperties()[].id`), which is the
`hotelId` to filter by here.

## Credentials to provision first (blocker)

Different auth from our current ARI push (which uses an IP-allowlist +
`GOOGLE_ARI_PARTNER_KEY`). The Travel Partner API needs:

1. A **Google Cloud service account** with the **Travel Partner API enabled**.
2. OAuth scope **`https://www.googleapis.com/auth/travelpartner`** (server-to-server
   JWT → access token; no user consent flow).
3. That service account **granted access to the Hotel Center partner account**
   (add it as a user in Hotel Center / via your Google partner contact).
4. The numeric **Travel Partner `ACCOUNT_ID`**.

Store the service-account key + account id as **Cloudflare dashboard secrets**
(e.g. `GOOGLE_TRAVELPARTNER_SA_JSON`, `GOOGLE_TRAVELPARTNER_ACCOUNT_ID`) — never in
the repo (public). Token minting = sign a JWT with the SA private key, exchange at
`https://oauth2.googleapis.com/token` for a short-lived bearer; cache it in memory
per isolate.

## How to connect it (provisioning steps)

One-time setup — most of it is on Google's side; only step 6 is code.

1. **Get the Travel Partner API allowlisted, then enable it.** It's a
   **restricted, trusted-partner API** — it does NOT appear in the Cloud console
   API Library search until Google allowlists your project. Email your Google
   **Technical Account Manager** (the Google Hotels contact for the `channex_ari`
   partner account) with your **GCP project number** and ask them to grant the
   Travel Partner API to it. Once granted, APIs & Services → Library → search
   "Travel Partner API" → **Enable**. (Per Google: "visible to trusted partners
   only. If you don't find the API… contact your Technical Account Manager.")
2. **Create a service account** in that project → **Keys → Add key → JSON** →
   download it. You get a `client_email` (…@….iam.gserviceaccount.com) and a
   `private_key`. (If you already have a service account for the Price Feeds /
   ARI project, you can reuse the same one — Google allows one SA for both.)
3. **Invite the service account into Hotel Center.** Hotel Center → Account
   settings → Users/Access → invite the SA's `client_email` as a user. **API
   access activates ~24h later** — it is not instant.
4. **Grab the numeric Account ID** from Hotel Center (Account settings). This is
   the `{ACCOUNT_ID}` in the endpoint path.
5. **Store as Cloudflare secrets** (dashboard, never repo — public):
   `GOOGLE_TRAVELPARTNER_SA_EMAIL`, `GOOGLE_TRAVELPARTNER_SA_PRIVATE_KEY`
   (the PEM, newlines intact), `GOOGLE_TRAVELPARTNER_ACCOUNT_ID`.
6. **Mint a token in the Worker (code).** No `googleapis` SDK on Workers — do the
   JWT flow manually with WebCrypto:
   - Build a JWT: header `{alg:"RS256",typ:"JWT"}`, claims `{ iss: SA_EMAIL,
     scope: "https://www.googleapis.com/auth/travelpartner",
     aud: "https://oauth2.googleapis.com/token", iat, exp: iat+3600 }`.
   - Sign it: `crypto.subtle.importKey("pkcs8", <der from the PEM>, {name:
     "RSASSA-PKCS1-v1_5", hash:"SHA-256"}, …)` then `crypto.subtle.sign`.
   - POST to `https://oauth2.googleapis.com/token` with
     `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>` →
     get `access_token` (valid ~1h). Cache it in-isolate until near expiry.
   - Call `GET https://travelpartner.googleapis.com/v3/accounts/{ACCOUNT_ID}/hotelViews?filter=…`
     with `Authorization: Bearer <access_token>`.

Verify with one manual call first (e.g. `filter=liveOnGoogle=TRUE`) to confirm the
SA is activated and the account id is right, before wiring the gate.

## Planned integration (when credentials exist)

Chosen shape: **indicator + gate the push.**

- `app/lib/google-ari/status.server.ts` → `getGoogleMatchStatus(hotelId)`:
  calls `hotelViews.list?filter=hotelId=…`, returns `{ matched, liveOnGoogle }`.
  Cache briefly (status changes slowly); tolerate errors.
- **Admin Google Hotels page**: show a badge per property — "Matched — ready for
  rates" / "Not matched yet — Google hasn't ingested this property" / "Live on
  Google". Add to the readiness panel next to the feed-readiness items.
- **Gate the ARI push** (`google-ari/push.server.ts`, cron + delta + edit-hook):
  skip properties where `matched === false`, and `log()` the skip. **Fail open** —
  if the status call itself errors, push anyway, so a Travel Partner API outage
  can't stall ARI.

## Notes

- This is a *read*/status check; it doesn't replace the ARI push, it guards it.
- `matchStatus` can lag feed ingestion by Google's own schedule, so the gate
  should be advisory (fail-open) rather than a hard stop that could indefinitely
  block a legitimately-fed property.
