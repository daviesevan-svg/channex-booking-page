# Admin access matrix — 2026-08-22

Same-tenant privilege review of the Roompanda booking-engine admin. **No product permissions were changed** for this document.

**Code:** `main` at `92226d8` (includes PR 478).  
**Scope:** every loader and action under `app/routes/admin/`. Cross-partner isolation was already judged sound (PR 478 / `docs/security-review-2026-08-22-pass2.md`); this pass is **who can do what inside one tenant**.  
**Policy:** findings and recommendations below are **not decided**. Evan decides what to flip.

---

## How to read this

### Roles (as the code actually models them)

| Label in this doc | What it is in code |
|---|---|
| **Teammate** | `User.role === "member"` **and** email is in `PropertyRef.members` for the property in play. Not the owner. |
| **Owner** | Email equals `PropertyRef.owner`. Not a `User.role` — ownership is per property. The user record is still usually `member`. |
| **partner_admin** | `User.role === "partner_admin"` with `user.partnerId` set. Column below assumes they **do not personally own** the hotel (the interesting case). If they *are* the owner, they get the **Owner** column as well. |
| **superadmin** | `User.role === "superadmin"` or email in `SUPERADMIN_EMAILS`. Sees every property. |

### Cell legend

| Cell | Meaning |
|---|---|
| **edit** | Can load the page and mutate (same gate on loader and action). |
| **see** | Can load; no mutating action, or mutation is blocked. |
| **partial** | Page loads; **some** intents are extra-gated (named in the notes). |
| **no** | Redirect, 404, or hard error. Cannot usefully operate the surface. |
| **\*** | Teammate cell only: owner may hide this **member area** on Team. Optional. Does **not** apply to owner, superadmin, or `partner_admin` of that property’s partner. |

### The six gates (every route uses some of these)

| Gate | Where | Who passes |
|---|---|---|
| `requireAdmin` | `auth.server.ts` | Signed-in session, host-bound, `canSignInOnHost`. Else redirect `/admin/login`. |
| `requireSuperadmin` | `auth.server.ts` | `requireAdmin` + `isSuperadmin`. Else redirect `/admin`. |
| `getVisibleProperties` / `canAccess` | `properties.server.ts` | superadmin: all. `partner_admin`: every property with matching `partnerId`, plus any they own or are a member on. Everyone else: own **or** teammate. |
| `currentPropertyId` | `properties.server.ts` | Session property ∩ visible list (else first visible). Then **`assertMemberAreaAllowed`** (404 if teammate area hidden). **This is the chokepoint** for property-scoped routes. |
| `isOwnerOrSuper` | `properties.server.ts` | Owner email **or** superadmin. **`partner_admin` is not included** unless they personally own the property. |
| `requirePageAllowed(page)` | `page-access.server.ts` | 404 if the user’s partner `hiddenPages` contains `page`. Exempt: superadmin, `partner_admin`, users with no partner. Default partner hide list: `connectivity`, `api-keys`, `webhooks`, `google-hotels`, `brand-kit`, `collections`. |

Nav hiding (`layout.tsx`) is **not** a gate. Loaders/actions re-check. Team / API keys / webhooks nav items appear only when `isOwnerOrSuper` (`canManageCurrent`). Users / Partners nav only when `isSuperadmin`.

Member areas (`member-areas.ts`) — only these prefixes are hideable: `operations`, `pricing`, `website`, `emails`, `payments`. Property details, General, Portal, Team, Connectivity, Google, Widget, Brand kit, Collections, Properties are **never** member-restrictable.

---

## Host-scoped partner admin vs book.roompanda.com

Admin identity is **the hostname of the request**, not the guest booking domain.

| Door | `adminHostPartnerId` | Who may sign in (`canSignInOnHost`) |
|---|---|---|
| Canonical / own hosts (`APP_URL`, `OWN_HOSTS` — includes **book.roompanda.com** if that host is “ours”) | `null` | Normal `canSignIn`, **except** a user whose partner already has `adminHost` — they are refused here so they cannot see Roompanda chrome. Superadmins always may. First sign-in may claim platform superadmin (`claimSuperadminIfUnclaimed`) — canonical only. |
| Partner `adminHost` (e.g. `admin.theirpms.com`) | that `partnerId` | Superadmins, or an **already-existing** user with `user.partnerId === host`. Invite-only; `ADMIN_EMAILS` open signup does not apply. Magic links are built from **this** origin. |
| Anything else (hotel custom domain, unknown host) | — | **404.** A hotel website host must never render `/admin`. |

Sessions store `partner` = the door they were minted on. `getAdminEmail` returns null if the cookie is presented on a different door (defence in depth; browsers already scope the cookie per host).

**Guest host** (`partner.guestHost`, e.g. `book.theirpms.com`) is **not** an admin door. Slug paths do not resolve on a partner **admin** host. “View site” and payment return URLs follow the **property’s** guest host.

`getVisibleProperties` does **not** re-intersect the list with the request host’s partner. Isolation on a partner admin host is sign-in + session binding. A `partner_admin` who somehow had a session on the canonical host (only possible if their partner has **no** `adminHost`, or they are also a superadmin) still only sees their partner’s properties plus ones they own/are on.

`/v1` and `/mcp` require the **canonical** host and a property API key. They are not an admin-role surface.

---

## Matrix

Columns: **teammate** on that property · **owner** · **partner_admin** of that property’s partner but **not** owner · **superadmin**.

Partner hotel **owners/teammates** may additionally 404 on `requirePageAllowed` pages when the partner hid them. `partner_admin` and superadmin never hit that hide. That is marked **(H)** on those rows.

| Surface | Teammate | Owner | partner_admin (not owner) | superadmin | Actual gate(s) |
|---|---|---|---|---|---|
| **Payments** — see Stripe/Viva status | edit\* | edit | edit | edit | `requireAdmin` + `currentPropertyId` (area `payments`). **No** `isOwnerOrSuper`. |
| **Payments** — connect / disconnect Stripe or Viva | edit\* | edit | edit | edit | Same. Callback uses `canAccess` on the session-bound property, not owner. |
| **General** — currency, timezone, languages, lead time, legal URLs | edit | edit | edit | edit | `requireAdmin` + `currentPropertyId`. Not member-restrictable. |
| **General** — live booking toggle + slug | edit | edit | edit | edit | Same action as above (`saveSettings` + `setPropertySlug`). **No** owner gate. |
| **Property details** — copy, photos, amenities, address | edit | edit | edit | edit | `requireAdmin` + `currentPropertyId`. Not member-restrictable. |
| **Property details** — public listing toggle | edit | edit | edit | edit | `setPropertyPublic` in `property.tsx` action. **No** owner gate. |
| **Properties list** — switch / view | see | see | see (all partner hotels) | see (all) | `requireAdmin` + `getVisibleProperties`. |
| **Properties list** — rename / delete / clone / toggle public | no | edit | **no** | edit | Action: `isOwnerOrSuper` (except `add` / `switch` / `reassign`). UI `canManage` = owner or superadmin. |
| **Properties** — add blank property | edit (becomes owner) | edit | edit (becomes owner; **no `partnerId` stamped**) | edit | `requireAdmin` only. |
| **Properties** — reassign owner | no | no | no | edit | `isSuperadmin` in action. |
| **Onboard Channex / Booking.com** | edit (new property, self as owner; `partnerId` from **user**) | edit | edit (stamps `user.partnerId`) | edit | `requireAdmin` only. |
| **Portal** — cancel/modify windows, **auto-refund** | edit | edit | edit | edit | `requireAdmin` + `currentPropertyId`. **No** owner gate. Not member-restrictable. |
| **Team** — invite / remove / hide areas | no (redirect `/admin`) | edit | **no** | edit | `isOwnerOrSuper` on loader **and** action. |
| **API keys** | no (empty list + action error) **(H)** | edit **(H)** | **no** (not owner) | edit | `requirePageAllowed("api-keys")` + `isOwnerOrSuper` to list or mutate. |
| **Webhooks** | no **(H)** | edit **(H)** | **no** | edit | Same pattern as API keys. |
| **Bookings list / PDF** | see\* | see | see | see | `requireAdmin` + `currentPropertyId` (area `operations`). |
| **Booking** — retry Channex, resend email, edit guest, **cancel** | edit\* | edit | edit | edit | Same; **no** owner gate on those intents. |
| **Booking — refund** | no\* (button hidden; action error) | edit | **no** | edit | `isOwnerOrSuper` on refund intent only. |
| **Voucher products** — CRUD / toggle / cooling-off | edit\* | edit | edit | edit | `requireAdmin` + `currentPropertyId` (area `pricing`). |
| **Voucher — complimentary issue** | no\* (action error; UI still shown) | edit | **no** | edit | `isOwnerOrSuper` (`voucherComp`). |
| **Voucher detail** — resend email | edit\* | edit | edit | edit | No owner gate. |
| **Voucher detail** — redeem / deduct / cancel / edit terms / **refund** | no\* | edit | **no** | edit | `isOwnerOrSuper`. |
| **Reviews** — list (incl. private notes) | see\* | see | see | see | `requireAdmin` + `currentPropertyId` (area `operations`). |
| **Reviews** — publish response | no\* (form still shown; action error) | edit | **no** | edit | `isOwnerOrSuper`. |
| **Google Hotels** — load / save push | no **(H)** if not owner; else see “owner-only” copy | edit **(H)** | **no** (owner-only copy) | edit | `requirePageAllowed("google-hotels")` + `isOwnerOrSuper` for save. |
| **Google** — merged feed rebuild / manual push | no | no | no | edit | `isSuperadmin` (feed rebuild is global, before property checks). |
| **Widget** — see snippet / preview | see | see | see | see | `requireAdmin` + `currentPropertyId`. Not member-restrictable. |
| **Widget** — apply theme JSON | no | edit | **no** | edit | `isOwnerOrSuper`. |
| **Brand kit** | see **(H)** | see **(H)** | see | see | `requirePageAllowed("brand-kit")`. No action. |
| **Website** — copy, sections, pages, footer, gallery, facilities, funnel pages | edit\* | edit | edit | edit | `requireAdmin` + `currentPropertyId` (area `website`). |
| **Website** — custom domain claim / enable / remove | edit\* | edit | edit | edit | Same. **No** owner gate. |
| **Website** — Cloudflare credential diagnostic | no | no | no | edit | `op === "testCf"` → `isSuperadmin`. |
| **Rooms / rates / taxes / promos / extras** | edit\* | edit | edit | edit | `requireAdmin` + `currentPropertyId` (area `pricing`). |
| **Inventory** — view | see\* | see | see | see | Same (area `operations`). Read-only if Channex connected. |
| **Inventory** — write ARI | edit\* (blocked if Channex) | edit (blocked if Channex) | edit (blocked if Channex) | edit (blocked if Channex) | Action refuses all writes when `isChannexConnected`. |
| **Analytics / ARI change log** | see\* | see | see | see | Loader only. |
| **Emails / templates / test send** | edit\* | edit | edit | edit | `requireAdmin` + `currentPropertyId` (area `emails`). |
| **Connectivity** — connect / disconnect Channex | edit **(H)** | edit **(H)** | edit | edit | `requirePageAllowed("connectivity")` + `currentPropertyId`. **No** owner gate. |
| **Collections** — list / create | edit **(H)** (own/operate only) | edit **(H)** | edit (own/operate only — **no partner-wide list**) | edit (all) | `requirePageAllowed("collections")`. Visibility is owner/operator, **not** `partner_admin` of hotels in the collection. |
| **Collection** — edit / analytics | only if owner or operator **(H)** | same | same | edit | `getVisibleCollections` / `canAccessCollection`. |
| **Users** | no | no | **no** | edit | `requireSuperadmin`. |
| **Partners / partner detail** (brand, hosts, hidden pages, assign hotels, add/remove `partner_admin`) | no | no | **no** | edit | `requireSuperadmin`. |
| **Select property** | edit (visible only) | edit | edit (partner hotels) | edit | `requireAdmin` + `canAccess`. |
| **Login / verify / logout** | n/a | n/a | n/a | n/a | Host-scoped; see § host. |
| **Admin language cookie** | edit (unauthenticated) | edit | edit | edit | `admin/lang.tsx` — **no** `requireAdmin`. Sets a UI cookie only. |

---

## (A) Too open — can change money, go-live, or identity they probably should not

These are **same-tenant**. A teammate or `partner_admin` cannot reach another partner’s hotels.

### Teammate (and `partner_admin` who is not owner)

1. **Payments connect / disconnect.** Any user who can open `/admin/payments` can attach their own Stripe Connect account or store Viva merchant credentials, or rip out the hotel’s. Member-area hide is optional and does not bind `partner_admin`. Highest-confidence “should not”.
2. **Live booking toggle.** `/admin/general` writes `liveBooking` with no owner gate. Turns real charges + Channex push on or off.
3. **Public listing.** `/admin` (`property.tsx`) calls `setPropertyPublic` on every save. Same flag on `/admin/properties` **is** owner-gated. Inconsistent, and it is identity / directory / Google-feed eligibility.
4. **Slug.** Same General save. Globally unique guest URL. A teammate can take or release `book.roompanda.com/yourhotel`.
5. **Portal auto-refund + guest cancel window.** `/admin/portal` — `autoRefund`, `allowCancel`, deadlines. A teammate can make every guest cancel refund automatically, or turn refunds off.
6. **Custom domain.** `/admin/website` — claim, provision, remove the hotel’s hostname. Identity at the DNS layer.
7. **Currency.** General save. Changes what checkout charges; Viva is currency-locked. Not “money movement” but it can break the gateway.
8. **Booking cancel (no refund).** Front-desk-shaped, but it releases inventory, emails guest/host, cancels in Channex, and fires `booking.cancelled`. Not owner-gated. Refund after the fact is owner-only — so a teammate can cancel and leave the charge in place.
9. **Connectivity.** If the partner did not hide the page (or the user is `partner_admin`), anyone can connect/disconnect Channex for that hotel. For a PMS, hotel users toggling this is exactly what `hiddenPages` is for — but `partner_admin` bypasses the hide, and **direct** Roompanda teammates have no hide at all.
10. **Add property.** Any signed-in admin can create a property they then **own**. A teammate invited to hotel A can mint hotel B and become its owner (payments, live, team, …).
11. **Manual add does not stamp `partnerId`** (pass-2 M4). A `partner_admin` “Add property” creates a **direct** Roompanda property. If they mark it public, it can appear on Roompanda’s picker. Clone (`cloneProperty` → `addProperty` without partner) has the same gap. Channex / Booking.com onboard **do** stamp `user.partnerId`.
12. **Guest PII.** Booking `editGuest` + email resend; voucher `resend`; review private notes are visible to every teammate with Operations. Probably fine for the desk; listed because it is not owner-gated.
13. **`/admin/properties` loader** returns full `PropertyRef` (including `members` and `memberHiddenAreas`) to every viewer. The **UI** only prints owner/team counts for superadmin; the SSR payload still has the emails. Layout deliberately strips this from the header switcher. Recommendation-only: trim the list payload the same way.

### `partner_admin` specifically (on hotels they do not own)

They can do **all of the teammate-open items above** on **every** hotel of their partner, and:

- **Bypass `hiddenPages`.** They always see Connectivity, API keys page (but cannot operate keys — too tight), Google (cannot save), Brand kit, Collections.
- **Bypass member-area hiding.** An owner cannot lock a `partner_admin` out of Payments or Operations.

That is the product shape in `whitelabel.md` §4 (`partner_admin` “chose the list”). Combined with no owner gate on Payments / live / public / slug / auto-refund, a PMS staffer who is not the hotel owner can still take the hotel live and re-point Stripe.

---

## (B) Too tight — cannot do an ops task they probably should

### `partner_admin` on a hotel they do not own

`isOwnerOrSuper` treats them like a teammate. They **see** the hotel (and more than a teammate: no area hide) but **cannot**:

| Blocked control | Why it is likely an ops gap |
|---|---|
| Team invite / remove / area hide | PMS cannot add the night manager without becoming `PropertyRef.owner` or asking a superadmin. |
| API keys / webhooks | Docs say the developer surface “belongs to the PMS”. The hide is bypassed, but **mutate** still requires owner. PMS staff cannot issue a key for a hotel they oversee. |
| Booking refund / voucher refund / voucher comp | Support-shaped money movement is owner-only. PMS support cannot refund. |
| Google Hotels save (push on/off, program, window) | Programme-level, and default-hidden from hotels — but the PMS admin also cannot save it unless they own the row. |
| Widget theme apply | Odd next to Website → Sections, which they **can** theme. |
| Review response | Form shows; action rejects. |
| Properties rename / delete / clone / public toggle (list page) | They can still flip public via Property details. Rename-from-list and clone are blocked. |
| Scoped user admin | `whitelabel.md` §3: “`partner_admin` gets a scoped equivalent (their users, their properties’ owners/members)”. **Not built.** `/admin/users` and `/admin/partners/:id` (`addAdmin` / `removeAdmin`) are `requireSuperadmin` only. |
| Partner-wide collections | Collection visibility is owner/operator email, not “any collection that lists my partner’s hotels”. They can create their own. |

None of this is a cross-partner leak. It is “PMS staff can see the hotel and change Stripe, but cannot refund or add a teammate.”

### Teammate

Usually correctly tight (team, keys, webhooks, refunds, Google save, widget theme). Weaker UX bugs, not privilege:

- Reviews and voucher-comp **show** controls the action will reject.
- They can cancel a booking but cannot refund it (see A.8).
- They cannot read API key metadata even as view-only (page loads empty).

---

## Recommended model (not decided)

Today there are effectively two write classes: **anyone with `canAccess`** and **`isOwnerOrSuper`**. `partner_admin` is in the first for visibility and the second for almost nothing.

**Recommendation:** introduce a third helper and stop overloading `isOwnerOrSuper`.

```ts
// Recommendation only — not implemented.
canManageProperty(request, id) =
  superadmin
  || property.owner === email
  || (user.role === "partner_admin" && user.partnerId === property.partnerId)
```

Keep `isOwnerOrSuper` (or a rename `canOwnProperty`) for things that should stay **hotel-owner + platform**, not PMS staff.

### Suggested placement

| Put on `canManageProperty` (owner **or** partner_admin of that partner **or** superadmin) | Stay **owner-only** (not PMS, not teammate) | Stay **teammate-ok** (content / desk) |
|---|---|---|
| Team invite / remove / area hide | **Payments** connect / disconnect | Rooms, rates, taxes, promos, extras |
| API keys, webhooks | **Live booking** toggle | Photos, gallery, facilities, website copy/sections/pages |
| Booking refund, voucher refund / comp / redeem / deduct / cancel-voucher | **Slug** (guest identity URL) | Inventory (when not Channex-locked) |
| Google Hotels **save** (not global feed rebuild) | **Public listing** (both Property details **and** Properties list — same gate) | Emails / templates |
| Review respond | **Portal auto-refund** (and maybe `allowCancel`) | Bookings: view, PDF, retry, resend, edit guest |
| Widget theme (or drop the extra gate and treat like Website theme) | Property **delete** / ownership transfer | Booking **cancel** (if you want a desk role) |
| Connectivity connect/disconnect (PMS ops; hotel users still gated by `hiddenPages`) | | Voucher **product** CRUD (not money ops) |
| Properties rename / clone (clone should also stamp `partnerId`) | | Analytics, ARI log |
| Scoped partner user list (new page or filtered `/admin/users`) — as `whitelabel.md` already sketched | | |

**Also recommend (still not decided):**

- Stamp `partnerId` from `getUser(email)` on **Add property** and **clone**, matching onboard.
- One public-listing gate, used by both `property.tsx` and `properties.tsx`.
- Hide review-response / voucher-comp UI when the actor fails the gate (loader already has the bit on some pages).
- Member-area hide remains an **owner → teammate** overlay only. Do not apply it to `partner_admin`.
- `hiddenPages` stays a **partner → hotel user** overlay. Do not apply it to `partner_admin`.
- Global Google feed rebuild and Cloudflare `testCf` stay **superadmin**.
- Users / Partners platform pages stay **superadmin**, except a **scoped** partner-user roster if you want PMS self-service.

---

## Per-route loader / action (every admin file)

Gates listed are the **server** checks. “Who” is for a user acting on a property they can already see, unless noted.

### Auth / session (outside or beside the layout)

| File | Path | Loader | Action | Who loads | Who mutates |
|---|---|---|---|---|---|
| `login.tsx` | `/admin/login` | `adminHostPartnerId` (404 unknown host); redirect if `getAdminEmail` | Host + throttle + `canSignInOnHost`; may send magic link | Anyone on a valid admin host | Same (email send only if allowed) |
| `verify.tsx` | `/admin/verify` | Host + `verifyMagicToken` + `canSignInOnHost` → `createAdminSession` | — | Token holder | Session mint |
| `logout.tsx` | `/admin/logout` | redirect `/admin` | `logout` (no auth) | — | Anyone (destroys cookie) |
| `lang.tsx` | `/admin/lang` | redirect `/admin` | **No `requireAdmin`.** Sets admin UI lang cookie; safe redirect | — | Anyone who can POST |
| `layout.tsx` | `/admin/*` | `requireAdmin`; `currentPropertyId`; `getVisibleProperties`; `isOwnerOrSuper` → nav; `hiddenPagesFor`; `hiddenMemberAreasFor` | — | Any signed-in admin | — |
| `select-property.tsx` | `/admin/select-property` | unused | `requireAdmin` + `canAccess`; `redirectTo` must start `/admin` | — | Visible-property switch |

### Money / go-live / identity

| File | Path | Loader | Action | Who loads | Who mutates |
|---|---|---|---|---|---|
| `payments.tsx` | `/admin/payments` | `requireAdmin` + `currentPropertyId` | Same. Intents: `connect`, `disconnect`, `viva-connect`, `viva-disconnect` | Any accessor (area `payments` for teammates) | Same — **no owner gate** |
| `payments.callback.tsx` | `/admin/payments/callback` | `requireAdmin` + consume nonce + **`canAccess(propertyId)`** + Stripe token exchange | — | Accessor of the stamped property | Writes payment settings |
| `general.tsx` | `/admin/general` | `requireAdmin` + `currentPropertyId` | Same: `saveSettings` + `setPropertySlug` (live, currency, slug, …) | Any accessor | Same — **no owner gate** |
| `property.tsx` | `/admin` | `requireAdmin` + `currentPropertyId` | Same: overrides, images, amenities, `renameProperty` (default lang), **`setPropertyPublic`** | Any accessor | Same — **public is not owner-gated here** |
| `portal.tsx` | `/admin/portal` | `requireAdmin` + `currentPropertyId` | `savePortalSettings` (cancel, **autoRefund**, modify, copy) | Any accessor | Same — **no owner gate** |
| `website.tsx` | `/admin/website` | `requireAdmin` + `currentPropertyId` | Domain claim/check/provision/remove, `websiteEnabled`. `testCf` → `isSuperadmin` | Any accessor (area `website`) | Domain: any accessor. CF test: superadmin |

### Owner-gated property controls

| File | Path | Loader | Action | Who loads | Who mutates |
|---|---|---|---|---|---|
| `team.tsx` | `/admin/team` | `requireAdmin` + `currentPropertyId` + **`isOwnerOrSuper` else redirect `/admin`** | Same + invite re-checks owner per target property | Owner / superadmin | Same. Invite stamps `partnerId` on **new** users only |
| `api-keys.tsx` | `/admin/api-keys` | `requireAdmin` + `requirePageAllowed("api-keys")` + `currentPropertyId`; keys listed only if `isOwnerOrSuper` | `isOwnerOrSuper` or error. `create` / `revoke` | Page: any accessor not hidden; secrets: owner/super | Owner / super |
| `webhooks.tsx` | `/admin/webhooks` | Same pattern (`"webhooks"`) | `isOwnerOrSuper`. `add` / `remove` | Same | Owner / super |
| `website-widget.tsx` | `/admin/website-widget` | `requireAdmin` + `currentPropertyId`; `canManage = isOwnerOrSuper` | Theme JSON only if `isOwnerOrSuper` | Any accessor (snippet visible) | Owner / super |
| `google-hotels.tsx` | `/admin/google-hotels` | `requireAdmin` + `requirePageAllowed("google-hotels")` + `currentPropertyId`; `canManage` / `superadmin` flags | `refreshFeed` / `refreshVrFeed`: **superadmin**, no property. Else `isOwnerOrSuper`. `push`: also superadmin | Non-owner: owner-only message (if page allowed) | Save: owner/super. Feed/push: superadmin |
| `reviews.tsx` | `/admin/reviews` | `requireAdmin` + `currentPropertyId` | **`isOwnerOrSuper`** for `respond` | Any accessor (area `operations`) — **includes private notes** | Respond: owner / super |

### Bookings / vouchers

| File | Path | Loader | Action | Who loads | Who mutates |
|---|---|---|---|---|---|
| `bookings.tsx` | `/admin/bookings` | `requireAdmin` + `currentPropertyId` | — | Any accessor (area `operations`) | — |
| `booking.tsx` | `/admin/bookings/:id` | Same + `getBooking(pid, id)` + `canRefund = isOwnerOrSuper` | retry / resendEmail / editGuest / cancel: accessor. **refund: `isOwnerOrSuper`** | Any accessor | Cancel etc.: accessor. Refund: owner / super |
| `booking-pdf.tsx` | `/admin/bookings/:id/pdf` | `requireAdmin` + `currentPropertyId` + booking | — | Any accessor | — |
| `vouchers.tsx` | `/admin/vouchers` | `requireAdmin` + `currentPropertyId` | selfService / delete / toggle / save: accessor. **`voucherComp`: `isOwnerOrSuper`** | Any accessor (area `pricing`) | Products: accessor. Comp: owner / super |
| `voucher.tsx` | `/admin/vouchers/:code` | Same + `canManage = isOwnerOrSuper` | `resend`: accessor. markRedeemed / deduct / cancel / editTerms / **refund**: `isOwnerOrSuper` | Any accessor | Money/status: owner / super |

### Catalogue / website / emails (standard accessor pattern)

All: **`requireAdmin` + `currentPropertyId`**. Area in parentheses is the teammate hide, if any.

| File | Path | Action mutations | Area |
|---|---|---|---|
| `inventory.tsx` | `/admin/inventory` | ARI write; **refused if Channex connected** | operations |
| `analytics.tsx` | `/admin/analytics` | — | operations |
| `ari-log.tsx` | `/admin/ari-log` | — | operations |
| `rooms.tsx` | `/admin/rooms` | — | pricing |
| `room.tsx` | `/admin/rooms/:roomId` | Room CRUD | pricing |
| `rates.tsx` | `/admin/rates` | — | pricing |
| `rate.tsx` | `/admin/rates/:rateId` | Rate CRUD | pricing |
| `taxes.tsx` | `/admin/taxes` | Save taxes | pricing |
| `promotions.tsx` | `/admin/promotions` | Promo CRUD | pricing |
| `extras.tsx` | `/admin/extras` | Extras CRUD | pricing |
| `emails.tsx` | `/admin/emails` | Email settings | emails |
| `email.tsx` | `/admin/emails/:template` | Save template; `test` sends to the signed-in admin | emails |
| `home.tsx` | `/admin/home` | Home / search / hero | website |
| `website-sections.tsx` | `/admin/website/sections` | Theme + sections (brand colour lives here) | website |
| `website-pages.tsx` | `/admin/website/pages` | CMS pages | website |
| `website-footer.tsx` | `/admin/website/footer` | Footer | website |
| `gallery.tsx` | `/admin/gallery` | Images | website |
| `facilities.tsx` | `/admin/facilities` | Facilities | website |
| `page.tsx` | `/admin/pages/:page` | Funnel copy | website |

### Platform / multi-property

| File | Path | Loader | Action | Who loads | Who mutates |
|---|---|---|---|---|---|
| `properties.tsx` | `/admin/properties` | `requireAdmin` + visible list; `canManage` per row = owner or superadmin; user list only if superadmin | `add`: any admin (no `partnerId`). `reassign`: superadmin. `switch`: `canAccess`. clone / rename / delete / `togglePublic`: **`isOwnerOrSuper`** | Any admin (their visible hotels) | See intents |
| `onboard-channex.tsx` | `/admin/properties/onboard` | `requireAdmin` | `requireAdmin`; import creates property owned by email; **`partnerId` from `getUser`** | Any admin | Any admin (new property) |
| `onboard-booking.tsx` | `/admin/properties/onboard-booking` | `requireAdmin` | Same; import stamps `partnerId` from user | Any admin | Any admin |
| `connectivity.tsx` | `/admin/connectivity` | `requireAdmin` + `requirePageAllowed("connectivity")` + `currentPropertyId` | connect / disconnect; **no owner gate** | Accessor if page allowed | Same |
| `brand-kit.tsx` | `/admin/brand-kit` | `requireAdmin` + `requirePageAllowed("brand-kit")` + `currentPropertyId` | — | Accessor if page allowed | — |
| `collections.tsx` | `/admin/collections` | `requireAdmin` + `requirePageAllowed("collections")` + `getVisibleCollections` (owner or operator) + memberships on **visible properties** | `add`: any allowed user (they become collection owner). `delete`: `canAccessCollection`. join/leave/invite: property in `getVisibleProperties` | Page-allowed users | Same, scoped as above |
| `collection.tsx` | `/admin/collections/:slug` | Same page gate; collection must be in `getVisibleCollections` | Mutations require collection in `getVisibleCollections` | Owner / operator / superadmin | Same |
| `collection-analytics.tsx` | `/admin/collections/:slug/analytics` | Same | — | Same | — |
| `users.tsx` | `/admin/users` | `requireSuperadmin` | `setRole` (member ↔ superadmin only, not `partner_admin`), `delete`, `setPartner`. Cannot target self or env superadmin | Superadmin | Superadmin |
| `partners.tsx` | `/admin/partners` | `requireSuperadmin` | Create partner | Superadmin | Superadmin |
| `partner.tsx` | `/admin/partners/:partnerId` | `requireSuperadmin` | update brand/hosts/`hiddenPages`; assign/unassign **direct** properties; `addAdmin` / `removeAdmin` (`partner_admin`); delete if empty | Superadmin | Superadmin |

`partner_admin` is granted only from `partner.tsx` (`setUserPartner(..., "partner_admin")`), not from `/admin/users` `setRole`.

---

## Related docs

- `docs/security-review-2026-08-22-pass2.md` — M4 (add-property `partnerId`), M6 (`partner_admin` ∉ `isOwnerOrSuper`), M7 (teammate payments / live / public / auto-refund). This matrix expands those; it does not change them.
- `docs/whitelabel.md` §3–§4 — intended role order and the still-unbuilt scoped partner user admin.
