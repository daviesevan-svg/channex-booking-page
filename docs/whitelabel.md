# White-label for PMS partners

Let a PMS resell the booking engine under its own brand, for a monthly fee.
Their hotels get "the PMS's booking engine"; Roompanda is invisible to them.

> **Status (2026-08-07):** phase 1 shipped in #406–#408 (partner model,
> partner_admin, in-app branding, page access, public exclusions, usage
> counts); phase 2 domains shipped in #410 (admin hosts + host-bound identity)
> and #411 (guest hosts + partner picker + slug host-discipline). Answered
> questions: hotels log in themselves; Channex stays ours; payments stay
> per-hotel Stripe Connect; pricing deferred to manual invoicing. Per-partner
> email sending domains shipped 2026-08-14 (§6 phase 2 — `partner.emailFrom`,
> domain verified by hand in SparkPost). Still open: all of phase 3 (partner
> API, SSO, metered billing).

The guiding constraint: **one deployment, one codebase**. A partner is a row of
configuration, not a fork or a second Worker. Everything a partner changes —
name, logo, domains, sender, visible pages — is data resolved per request, the
same way a property's theme already is.

---

## 0. What is already white-label (and what is not)

The **guest funnel is effectively white-label today**: booking pages carry the
hotel's own theme/logo/domain, guest emails use the hotel's display name, and
the admin copy no longer names Channex (the "channel manager" rename). None of
that changes.

The gaps are all on the **operator side**:

| Surface | Today | Anchor |
|---|---|---|
| Admin chrome | "Booking Admin" + diamond mark, Roompanda-neutral but OUR brand | `layout.tsx:305`, `login.tsx:56`, `mtAdmin` |
| Admin host | canonical hosts only; `/admin` 404s elsewhere by design | `requireCanonicalHost` (domains.server.ts) |
| Magic-link email | "Your admin sign-in link", global `EMAIL_FROM` | `sendMagicLink` (auth.server.ts) |
| Team invite email | "…access to manage X **on Roompanda**" | email.server.ts ~215 |
| Sign-up | `ADMIN_EMAILS` allowlist or fully open, global | `canSignIn` |
| Grouping | properties have an `owner` + `members`; nothing above that | `PropertyRef` |
| Page access | role-gated items only (team/api-keys/webhooks, users) | layout.tsx nav + per-route loaders |
| Billing | none (only `STRIPE_PLATFORM_FEE_BPS` per booking, unused) | config.server.ts |
| Shared guest domain | `book.roompanda.com/{slug}` + guest page title "Book direct — Roompanda" | search.tsx:80 |
| Developer surface | `Roompanda-Signature`, OpenAPI title | webhooks.server.ts, openapi.ts |

---

## 1. The partner model

New KV entity, per-key like users (`partner:{id}`), plus a small host index.

```ts
interface Partner {
  id: string;                    // slug-ish, stable
  name: string;                  // "HotelSoft Ltd" (internal)
  brandName: string;             // "HotelSoft Bookings" — used everywhere we'd say Roompanda
  logoImage?: string;            // admin header + login card + emails
  accentColor?: string;          // operator-email accent (team invites render uniform per partner, not per hotel theme); admin chrome later
  supportEmail?: string;         // reply-to on operator emails; shown on errors
  // ----- domains (phase 2) -----
  adminHost?: string;            // admin.hotelsoft.com  → partner-branded admin
  guestHost?: string;            // book.hotelsoft.com   → shared slug domain for their hotels
  // ----- email (phase 2) -----
  emailFrom?: string;            // verified per-partner sender; unset = global domain + brandName display name
  // ----- access -----
  hiddenPages?: string[];        // route ids their hotel users never see (see §4)
  inviteOnly?: boolean;          // default true: no open self-signup on their host
  // ----- billing -----
  feePerPropertyMinor?: number;  // monthly, for the usage page / Stripe metering
  stripeCustomerId?: string;     // phase 3
}
```

Two field additions elsewhere, both optional so existing data is untouched:

- `PropertyRef.partnerId?` — unset = a direct Roompanda property.
- `User.partnerId?` + `Role` gains `"partner_admin"` — PMS staff. A
  `partner_admin` sees every property of their partner, manages their users,
  and nothing global.

**Nothing about the data layer changes.** Rooms/rates/ARI/bookings stay keyed
by property id. The partner is a lens over the registry, exactly like
`owner`/`members` already are.

---

## 2. Identity comes from the hostname

This is the load-bearing decision. Custom-hostname plumbing already exists for
guest domains (`ensureCustomHostname`, the wildcard Worker route, per-host KV
claims). White-label reuses it for two partner hosts:

- `adminHost` → the partner-branded **admin**. `requireCanonicalHost` becomes
  `requireAdminHost`: allow canonical hosts (Roompanda context) **or** a
  registered partner `adminHost` — and return which partner. Everything
  downstream of that is scoped: login page branding, `canSignIn`, visible
  properties, nav, emails.
- `guestHost` → a shared slug domain for their hotels
  (`book.hotelsoft.com/{slug}`), alongside the existing per-hotel custom
  domains which keep working unchanged.

Sessions minted on a partner host embed the `partnerId` and are only honoured
on that host (cookies are host-scoped anyway; the embedded claim is defence in
depth and lets superadmins on canonical hosts operate cross-partner).

Two consequences worth stating out loud:

- **Pre-login branding requires the host.** Until a partner has a real
  `adminHost`, their hotels would see a Roompanda-hosted login URL. So phase 1
  (no DNS) is white-label *inside* the app, and true white-label lands with
  phase 2 domains. Set expectations with the pilot PMS accordingly.
- The hard-learned rule stands (see multitenant guard memory/PR): host gating
  is enforced in **loaders**, never by hiding links. A partner host must 404
  the platform pages, and the canonical host must 404 nothing it serves today.

---

## 3. Users, invites, sign-in

- **`canSignIn` becomes host-aware.** On a partner host: superadmins, that
  partner's `partner_admin`s, and users whose `partnerId` matches (invited
  hotel staff). No open self-signup regardless of `ADMIN_EMAILS` (partners are
  invite-only by default). On canonical hosts: today's behaviour, minus users
  that belong to a partner — a hotel user of HotelSoft must not be able to log
  in on admin.roompanda.com and see a Roompanda-branded product (support
  confusion, brand leak).
- **Invites carry the partner.** The existing per-property team invite
  (`team.tsx`) sets `User.partnerId` from the property's partner at creation.
  Magic links already build from the request origin (`login.tsx`), so links
  sent from a partner host land on the partner host — that part is free.
- **Invite + magic-link emails are branded** from the partner: sender display
  name = `brandName`, copy loses the hardcoded "on Roompanda", reply-to =
  `supportEmail`. One `brandForRequest()/brandForProperty()` helper resolves
  partner → defaults, used by every operator-facing email.
- **Invites are visually UNIFORM per partner** (shipped 2026-08-14): a partner
  property's team invite renders with `partner.accentColor` (default: platform
  accent) on the default email template, never the hotel's theme — a partner's
  hotels each had their own colours, which read as inconsistent PMS branding to
  the partner. Direct properties keep their hotel theme; guest emails stay
  hotel-themed always.
- **First-sign-in superadmin claim** (`claimSuperadminIfUnclaimed`) must be
  canonical-host-only — a partner's first hotel user must never claim anything.
- `/admin/users` stays superadmin. `partner_admin` gets a scoped equivalent
  (their users, their properties' owners/members) — cleanest as the existing
  page with a partner filter, not a second page.

---

## 4. Page access control

Two independent layers, both enforced in loaders:

1. **Role** (exists, extended): `member` < property owner < `partner_admin` <
   `superadmin`. Owner-only items (team, api-keys, webhooks) stay as they are.
2. **Partner feature flags**: `partner.hiddenPages` — route ids the partner
   doesn't want their hotels to have. The nav sections in `layout.tsx` are
   already stable-id'd; give each nav item a route id and one shared
   `requirePageAllowed(partnerId, routeId)` in the affected loaders.

Sensible default preset for a PMS partner (they can loosen it):

| Hidden by default | Why |
|---|---|
| `connectivity` | the PMS pre-wires the channel; a hotel toggling it breaks the PMS's own sync |
| `api-keys`, `webhooks` | developer surface belongs to the PMS, not the hotel |
| `google-hotels` | programme-level decision the PMS makes centrally (or sells separately) |
| `brand-kit`, `collections`, `properties` picker | Roompanda-platform features; hotels under a PMS have one property and no cross-property life |

Everything operational (inventory, bookings, rates, promotions, website,
emails, payments) stays visible — that's the product they're buying.

`partner_admin` bypasses `hiddenPages` (they're the ones who chose them) but
not the superadmin gates.

---

## 5. Branding surfaces (the actual find-and-fix list)

Resolved via one helper, defaulting to today's values when there's no partner:

- Admin header + login card: `brandName` + `logoImage` instead of "Booking
  Admin" + diamond (`layout.tsx`, `login.tsx`); `mtAdmin` browser title.
- Accent: reuse the existing theme-token override mechanism (set
  `--accent` etc. on the admin root from partner config — same trick as
  property themes; check built CSS keeps the var, the `@theme inline` gotcha).
- Operator emails: magic link, team invite (§3).
- Guest emails: already property-branded; the **from domain** is the only leak
  (phase 2, §6).
- Guest page `<title>` on the shared domain: "Book direct — Roompanda" →
  brand of the host (`search.tsx:80`).
- Booking PDFs: property-branded already; audit for any platform footer.
- Root picker `/` on canonical hosts: filter out partner properties (a PMS's
  hotels must not be listed on Roompanda's public front door or directory —
  default `directoryListed: false` when `partnerId` is set).
- Widget/brand-kit copy that prints shared-domain URLs: use the partner
  `guestHost` when set.
- Keep for later, explicitly not in scope: `Roompanda-Signature` header and
  OpenAPI title (developer-facing; renaming breaks integrations — if it ever
  matters, add a generic alias header rather than renaming).

The i18n mechanism already supports this: brand strings become `{brand}`
interpolations in the six dictionaries rather than new copy.

---

## 6. Email deliverability (phased deliberately)

- **Phase 1:** keep the single verified SparkPost sending domain; partner
  branding is display-name only (`"HotelSoft Bookings" <no-reply@<global>>`),
  reply-to = partner support. Zero deliverability risk, zero partner DNS work.
- **Phase 2 (SHIPPED):** optional per-partner sending address
  (`partner.emailFrom`, e.g. `noreply@theirpms.com`), set by a superadmin on the
  partner page. Verification is deliberately MANUAL: we add the domain + DKIM in
  the SparkPost dashboard first, then enter the address — which is why the field
  is superadmin-only rather than partner self-service, and why there's no in-app
  DNS flow. Once set, every email for that partner follows it: magic links and
  team invites (display name = brand name), and all guest/host emails for the
  partner's properties — bookings, cancellations, reviews, vouchers, contact,
  collections — via `senderFor(pid)` (email.server), which resolves the
  property's partner and keeps the property's `emailFromName` display-name
  override on top. Unset = phase-1 behaviour (global domain). In-app DNS
  self-service via the SparkPost API can come later if partners need it.

---

## 7. Guest side

- `guestHost` maps host → **partner**, and the path slug picks the property
  *within that partner* (`resolveRequestProperty` grows a partner-host branch).
  Slugs stay globally unique — no per-partner slug namespaces; collisions are
  rare and the error is legible ("slug taken").
- `/` on a partner guest host: partner-branded picker of that partner's public
  properties (reuse the root picker filtered by partner), or redirect to the
  PMS's site if they prefer (`partner` config later; picker first).
- Per-hotel custom domains keep working exactly as today, partner or not.

## 8. PMS integration (what "part of their PMS" really means)

Phase 3, but the plan should aim at it because it's what they're paying for:

- **Partner API key** (`pk_partner_…`, KV like the per-property keys):
  - `POST /partner/v1/properties` — create/onboard a property (the existing
    Channex-import flow, driven by API),
  - `POST /partner/v1/properties/{id}/invites` — invite a hotel user,
  - `GET /partner/v1/properties` + usage (active count, bookings) for billing
    reconciliation.
- **SSO handoff** so the PMS can embed or deep-link the admin: PMS backend
  signs `{email, propertyId, exp}` with its partner secret → 
  `POST {adminHost}/partner/sso` → verify, upsert user under the partner, mint
  the normal session, redirect. That removes magic-link friction entirely for
  hotels who live in the PMS UI. (Embedding in an iframe additionally needs a
  per-partner `frame-ancestors` CSP allow — decide when a partner actually
  asks.)

## 9. Billing

They offered "a small fee per month" — don't over-build:

- **Phase 1:** superadmin partner page shows billable usage (active properties
  per month, bookings) and `feePerPropertyMinor`. Invoice manually.
- **Phase 3:** Stripe subscription per partner (ordinary Stripe Billing on OUR
  account — nothing to do with the hotels' Connect accounts), metered
  per-property quantity updated by the existing cron. Keep
  `STRIPE_PLATFORM_FEE_BPS = 0` for partner properties unless a partner deal
  says otherwise — flat SaaS fee and per-booking take are different products;
  mixing them silently would sour the deal.

## 10. Isolation checklist (each one is a loader-level test)

- `getVisibleProperties`: partner_admin → their partner's; member → theirs
  (unchanged); on a partner host additionally *intersect* with that partner.
- Property create/clone under a partner context always stamps `partnerId`.
- Root picker, directory, collections: exclude partner properties on canonical
  hosts; collections membership constrained to one partner.
- `/admin/users`, provisioning cron pages: canonical + superadmin only.
- Sign-in cross-checks (§3) in both directions.
- Slug/custom-domain claims: unchanged (global uniqueness is a feature here).
- Seeding/bootstrap (`claimSuperadminIfUnclaimed`, `DEFAULT_PROPERTY_ID`
  auto-seed): canonical host only.

---

## 11. Phasing

**Phase 1 — partner model + in-app white-label (no DNS).**
Partner entity + superadmin management page; `partnerId` on properties/users;
`partner_admin` role; branded admin chrome/emails via `brandFor*`; `{brand}`
i18n interpolation; `hiddenPages` enforcement; partner-scoped invites and
sign-in rules; usage page for manual billing. *A pilot PMS can onboard hotels
and operate — the login URL is still ours.*

**Phase 2 — domains + email domains (true white-label).**
`adminHost`/`guestHost` via the existing custom-hostname flow;
`requireAdminHost` + host-bound sessions and sign-in; partner-branded login;
partner guest picker; optional verified sending domain. *The PMS's hotels
never see a Roompanda URL.*

**Phase 3 — self-serve + automation.**
Partner API (provision/invite/usage), SSO handoff (embed in the PMS), Stripe
metered billing, partner self-serve settings.

Rough shape: phase 1 is the bulk of the model/plumbing work; phase 2 is mostly
reusing the hostname machinery plus careful auth tests; phase 3 is additive.

## 12. Open questions (need Evan/partner answers before phase 1 lands)

1. **Payments stay per-hotel Stripe Connect** (partner never touches guest
   money) — confirm; it also means Payments/onboarding pages stay visible.
2. **Do hotels log in at all**, or does the PMS operate everything? If the PMS
   operates, `hiddenPages` matters less and SSO matters more — changes phase
   ordering.
3. **Channex relationship per partner**: all partner hotels connect through the
   same OpenShopping channel as today (Roompanda's), or does the PMS bring its
   own Channex group/channel? Affects onboarding (whose API key) and who pays
   Channex.
4. Pricing model: flat per property/month only, or partner base fee + per
   property? (Billing page shape.)
5. Support routing: `supportEmail` as reply-to everywhere operator-facing — is
   the PMS ready to take first-line support?
6. May partner hotels appear in Roompanda Collections if *they* want to, or
   never? (Default plan: never, unless the partner opts the property in.)
