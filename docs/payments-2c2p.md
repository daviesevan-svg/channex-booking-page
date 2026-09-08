# 2C2P payment gateway

2C2P is the fourth per-property gateway beside Stripe, Viva and iyzico, for
properties in South-East Asia (Thailand, Singapore, Malaysia, Indonesia, the
Philippines, Vietnam, Hong Kong…). Hosted payment page only: the guest leaves
for 2C2P's page and comes back; we never see a card.

Code: `app/lib/2c2p.server.ts` (client), `app/routes/property/2c2p.return.tsx`
(guest return), `app/routes/property/2c2p.notify.tsx` (server-to-server
result), the `2c2p` branches in `checkout.tsx`, `booking-finalize.server.ts`,
`refunds.server.ts`, `admin/payments.tsx` and `admin/booking.tsx`.

## What the hotel does

1. Get a 2C2P merchant account (2C2P onboards them; sandbox accounts come
   from 2C2P too — there is no self-serve signup).
2. In the 2C2P merchant portal, copy the **Merchant ID** and the **secret
   key** (2C2P also calls it the SHA key).
3. On `/admin/payments`, pick 2C2P, paste both, tick "sandbox" if the
   credentials are sandbox ones, and connect. Nothing is configured on 2C2P's
   side: both return URLs travel with every payment request.

Connecting mints a real payment token for 1 unit of the property's currency
that is never paid (it expires on 2C2P's side after their default 20 minutes).
That exercises the merchant ID, the secret key and the currency at once; a
wrong secret is 2C2P's code 9042, an unknown merchant 9007, an unsupported
currency 5008. There is no static currency allow-list — 2C2P's coverage is per
merchant account, so the account itself is asked.

## Flow

```
checkout action ──POST /payment/4.3/paymentToken──▶ 2C2P
        │  {payload: HS256 JWT{merchantID, invoiceNo=ref, amount, currencyCode,
        │            frontendReturnUrl=…/2c2p/return?ref=, backendReturnUrl=…/2c2p/notify?ref=}}
        ◀── {payload: JWT{webPaymentUrl, paymentToken, respCode}}
        │
        └─303──▶ guest pays on 2C2P's page
                      │
        ┌─────────────┴──────────────┐
  GET/POST /2c2p/return?ref=    POST /2c2p/notify?ref=
  (guest's browser)             (2C2P's server, {payload: JWT})
        │                            │
        └──── both ignore what arrived and ask 2C2P ────┐
                                                        ▼
                    POST /payment/4.3/paymentInquiry {merchantID, invoiceNo=ref}
                    respCode 0000 → paid → finalizeBooking (idempotent by ref)
                    anything else → not paid → guest back to checkout, cart intact
```

Every request and response is `{"payload": "<JWT>"}`, HS256, keyed by the
merchant secret key **used as a UTF-8 string** (it looks like hex; it is not
decoded). Response JWTs are verified before they are believed, and the
algorithm is pinned to HS256. A request 2C2P cannot decode comes back as bare
JSON `{respCode, respDesc}` with no payload.

Amounts are decimal numbers at the currency's display precision (2C2P's own
IDR rule), not minor units.

## What is different from the other gateways

- **Refunds are not wired.** 2C2P's refund API (Payment Action) is a separate
  product using RSA-OAEP JWE + PS256 JWS with a merchant-generated key pair
  and 2C2P's public certificate — a key exchange the hotel would have to run
  first. `refundBookingCharge` returns `unsupported` for 2C2P bookings; the
  admin booking page says to refund in the 2C2P merchant portal instead of
  showing the refund button; auto-refund on guest cancellation is a no-op
  (the hotel refunds by hand). The hotel's cancellation email carries a
  system-rendered **"Refund owed to guest: <amount>"** row whenever a charged
  booking is cancelled and no refund is recorded — with "issue it in the 2C2P
  merchant portal" for 2C2P, and "from the booking page" for any other
  gateway whose automatic refund didn't happen (`email-render.server.ts`,
  `policyRefundNow` at the cancellation moment). Follow-up: implement the
  keyed variant, with the key material as an optional second credential set.
- **A mismatched charge is held, not refunded.** If finalize refuses the
  payment (amount/currency don't match the pending — near-impossible here,
  since we set both and look the invoice up by our own reference), the
  booking is recorded as `failed` with the payment attached, the hotel gets
  the booking-failed email with the reason, and the guest sees the "payment
  held" notice on checkout (`notice=held`) rather than "refunded".
- **No card-on-file** (same as Viva and iyzico): guarantee-only rates book
  without a card.
- **API bookings** (`POST /v1/bookings`, MCP) on a 2C2P property refuse paid
  rates with `payment_not_configured`, like iyzico — hosted checkout only.

## Not yet verified

The end-to-end pay → return → notify loop has not run against a 2C2P sandbox
merchant: the demo merchant's secret key is not public and we have no account.
What has been verified: the JWT construction (independent node:crypto vector
in `2c2p.test.ts`), the transport and error envelope against the live sandbox
(bad key → 9042, unknown merchant → 9007), the route/lookup contract
(`payment-return-lookup.test.ts`), typecheck, build. First live customer:
connect with sandbox credentials first and pay with 2C2P's test card
4111 1111 1111 1111 (CVV 123, OTP 123456).
