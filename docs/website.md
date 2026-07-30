# Website templates

Turn the booking engine into a full hotel website, opt-in per property.

The guiding constraint: **the website and the booking engine are the same
application**. Not a site that links to a booking engine — one app, one route
tree, one theme, one header. A guest never crosses a seam because there is no
seam to cross.

---

## 1. Concept

`SiteSettings.websiteEnabled` (default off).

| | `/:channelId` renders | Funnel |
|---|---|---|
| **off** | today's search page | unchanged |
| **on** | the website home page | unchanged |

When on, the search box doesn't disappear — it becomes a *section* of the home
page (usually inside the hero). The booking funnel (`/rooms`, `/extras`,
`/checkout`, `/manage`) is untouched: same layout, same tokens, same fonts, same
8 locales.

Turning it off restores the old home page exactly. Nothing is destroyed.

### Why the content is mostly already here

Everything below already exists and a section can read it with no new author input:

| Content | Source |
|---|---|
| Name, type, description, phone, email — per language | `PropertyOverrides` |
| Address parts + lat/lng | `SiteSettings.address*`, `latitude`/`longitude` |
| Logo, cover, hero image | `SiteSettings`, R2 |
| Accent themes, font pairs | `THEMES`, `FONT_PAIRS` |
| Rooms: description, images, facilities, amenities, occupancy | `CatalogRoom` |
| Rates + structured policies | `rate-policy.ts` |
| Extras and vouchers, each with a photo | `extras.ts`, `vouchers.ts` |
| Reviews + hotel responses | `reviews.server.ts` |
| Promotions / offers | `promotions.server.ts` |
| Check-in/out times, currency, languages | `SiteSettings` |
| Structured data | `hotel-jsonld.server.ts` |

A hotel that has finished booking-engine setup gets a website with close to zero
extra typing. That is the entire pitch.

**Rule: a section never stores content that already exists.** A rooms section
stores *which rooms and what layout*, never room copy. One source of truth, and
a price change on the rate never leaves a stale number on the homepage.

---

## 2. What's missing (the 30%)

Three real gaps, all property-level. Everything built so far was room-level or
funnel-level.

### 2.1 Property photo gallery — `gallery:{pid}`

The property has one cover, one hero, one logo. Rooms have arrays. There is no
property gallery, and every hotel site opens with 20 photos.

```ts
interface GalleryImage {
  id: string;
  url: string;        // /images/… (R2)
  alt?: string;       // per language
  caption?: string;   // per language
}
```

`uploadGalleryImage(pid, file)` alongside the existing helpers in
`images.server.ts`. Admin: multi-upload, drag to reorder, alt text per language.

### 2.2 Property facilities

`vrAmenities` exists but it is Google's controlled vocabulary for the Vacation
Rentals feed, gated to single-unit properties. It is a feed contract, not
display copy — **do not merge the two.** Keep them separate and offer a one-way
"copy from Google amenities" button for VR properties.

A curated icon-backed list plus free text:

```
Wifi · Parking · Pool · Restaurant · Bar · Spa · Gym · Breakfast
Air conditioning · Pet friendly · EV charging · Accessible
Beach access · Airport shuttle · Room service · Laundry
```

Curated because icons need a fixed key set. Free-text overflow for the rest.

### 2.3 Per-page SEO

Title, meta description, OG image per page.

This makes an existing debt blocking: every route's `meta()` hardcodes an
English `<title>`, so `/admin/portal` says `Admin · Customer Portal` while the
page renders `Portal do cliente`. Cosmetic today. On a hotel's own domain with
SEO attached, it's a defect. Fix as part of this work.

---

## 3. Section engine

No Liquid, no user-supplied templates. **Sections hardcoded in TypeScript** —
Shopify's model minus the templating language. Typechecked, fast at the edge,
and nothing user-authored is ever evaluated.

### Storage — `site:{pid}`

Follows the `LangMap<T>` pattern already in `overrides.server.ts`.

Structure lives **once**, in the default language. Copy is **per language**,
keyed by section id:

```ts
interface SiteSection {
  id: string;                          // stable, survives reorder
  type: SectionType;
  hidden?: boolean;
  settings: Record<string, unknown>;   // validated per type
}

interface SitePage {
  slug: string;                        // "" = home
  title: string;
  metaDescription?: string;
  ogImage?: string;
  sections: SiteSection[];
}

interface SiteConfig {
  pages: SitePage[];
  nav: { pageSlug: string; label?: string }[];
  footer: { columns: FooterColumn[]; note?: string };
  style?: SiteStyle;
}

// site:{pid}  →  { base: SiteConfig, copy: Record<lang, Record<string, string>> }
//                                           key = `${sectionId}.${field}`
```

Splitting structure from copy means editing German can never delete an English
section — which whole-config-per-language would allow. Each field falls back to
the base language, so a half-translated site renders complete rather than blank.

### Catalog

| Type | Reads | Author sets |
|---|---|---|
| `hero` | hero image, name | heading, intro, image, height, overlay, **booking widget on/off** |
| `booking` | live catalog | heading, inline or card |
| `rooms` | `CatalogRoom` | heading, intro, how many. Cards link to a room page |
| `gallery` | **new** gallery | heading, grid or masonry |
| `facilities` | **new** facilities | heading, columns |
| `richText` | — | heading, body, **its own pictures** + which side, align (text-only) |
| `reviews` | `reviews.server` | heading, min rating, count |
| `offers` | promotions | heading |
| `extras` | extras catalog | heading |
| `vouchers` | voucher catalog | heading |
| `map` | lat/lng, address | heading, zoom, directions copy. Click-to-load (see below) |
| `faq` | — | question/answer pairs |
| `contact` | phone, email, address, check-in/out | heading, intro, form on/off |
| `cta` | — | heading, text, button + target |

Registry in `app/lib/sections.ts` (pure — type, label, settings schema,
defaults). Components in `app/components/sections/`.

**Rich text takes no raw HTML.** A small allowlist renderer: bold, italic, link,
list. An injection hole on a hotel's own domain, on a site that also takes card
details, is not a trade worth making for markup convenience. Built — see
*Simple formatting* below.

---

## 4. Templates and themes

Orthogonal, and both non-destructive.

**A template** is a named preset that produces a `SiteConfig`. Applying one
replaces page structure and never touches property data, so switching template
is always safe and reversible.

| Template | Sections |
|---|---|
| Boutique | hero · richText · rooms · gallery · reviews · map · contact |
| Resort | hero · booking · facilities · rooms · extras · gallery · offers · reviews · map |
| Apartment *(single-unit)* | hero · booking · gallery · facilities · richText · map · faq |
| Minimal | hero(+booking) · rooms · richText · contact |

**A theme** is the existing token system, unchanged: 5 accents plus custom, 8
font pairs. Add a `SiteStyle` with 2–3 layout variants — header treatment,
section rhythm, corner radius — so two hotels on Boutique/Terracotta don't come
out identical.

---

## 5. Routing

### The contact section and its form

Details (address, phone, email, check-in/out) come from Property details and are
plain `tel:` / `mailto:` links — the half that always works.

The form is a convenience on top, and a public form that emails a hotel is a
spam vector, so it is deliberately narrow:

- rate limited to 5/hour per IP per property, before any recipient lookup
- honeypot field; a filled one is answered `ok` and dropped, because telling a
  bot it failed just invites a retry
- name/email/message capped at 100/200/2000 chars
- the subject line is built entirely from our own text plus the hotel's name —
  guest input never reaches a mail header (a newline there is header injection)
- the body goes through `renderSimpleEmail`, which escapes it
- `replyTo` is the guest, so the hotel can just hit reply

The form hides itself when there is no `hostNotifyEmail` / `emailReplyTo` /
contact email to deliver to — the same choice the action makes, so it can't
show a thank-you for a message that went nowhere.

### The map section and Google billing

A Maps JS load is billed per map, so a map that draws itself on page view
charges for every visitor — including everyone who never looks at it. The
section instead shows a **generic drawn map** (inline SVG; a Static Maps image
of the real location would be billable too) with a "Show map" button, and only
fetches Google on the click.

The address and a `maps.google.com/maps/dir` directions link are always shown
and cost nothing, which is what most guests actually want — so the click, and
the charge, is the exception rather than the default.

Two failure modes, both handled, because they're different:
- A key that Google never answers for **hangs** — `importLibrary` and `onerror`
  both stay pending. `loadGoogleMaps` races a 10s timeout.
- A key Google **rejects** resolves normally and then renders nothing. The only
  signal is the `gm_authFailure` global.

Either way the section falls back to the placeholder with a plain message, and
the directions link is rendered outside that branch so it survives both.

### Footer

Chrome on every website page, so it lives beside `pages` in `site:{pid}` rather
than inside one. Its per-language text sits in its OWN namespace
(`footerCopy`), because saving a language of `copy` replaces that whole map —
the sections editor renders every section so a replace is right there, but
sharing one map would mean each editor silently wiped the other's text.

Built-in links (rooms, vouchers, manage, terms, privacy) are derived live in the
layout, not stored, so they can't go stale. Social platforms are a fixed
allowlist and every URL is http(s)-only.

Hidden on checkout and confirmation, matching the header nav — a footer full of
exits is the same risk at the worst moment.

### Room pages

`/:channelId/room/:roomId` is the website's room page: photos, description,
what's in the room, the rate names, and an always-on availability calendar for
that room alone. It needs no dates, which is why it can't be the existing
`rooms/:roomId` — that one is the funnel's dated rate-selection step and
redirects home without dates.

Picking a range on the room calendar hands off to `rooms/:roomId?checkin=…`, so
the funnel is entered with dates already chosen. The calendar shares
`CalendarMonths` with the search popover, so it can't drift from the booking
gate; per-room availability comes from `getCalendarAvailability(…, { roomId })`,
the same function the search calendar uses.

The room page 404s when the website layer is off — there's no website for it to
belong to.

### Phase 1 — shared domain, no routing change

`/:channelId` index renders the home page when `websiteEnabled`, else the search
page. Extra pages are a dynamic sibling of the existing static children:

```
:channelId
  index          → website home, or search
  rooms          ┐
  checkout       ├ static: unchanged, always win the match
  vouchers       ┘
  :pageSlug      → website page  ("about", "dining", "spa")
```

React Router ranks static above dynamic, so `/spilman/rooms` still hits
`results.tsx`. Page slugs are validated on save against the funnel names
(`RESERVED_PAGE_SLUGS` in `pages.ts`, mirroring `RESERVED_SLUGS`) — otherwise a
hotel creates a page called "rooms" that can never be reached.

#### Identity, and why copy is scoped

A page's identity is its `id`, never its slug: renaming "about" to "our-story"
has to keep the copy already written in eight languages, and a slug is exactly
the thing a hotel changes its mind about. `page_{id}.title` /
`page_{id}.metaDescription` hold the per-language page text, in the same shared
copy map as the sections'.

Two consequences, both load-bearing:

- **Section ids carry the page.** Built-ins are named after their type so copy
  survives a remove-and-re-add, but the copy map is global — a bare `richText`
  on two pages would be one shared heading. Home keeps the bare type (that's
  what's already stored); every other page gets `${type}_${pageId}`.
- **Saving copy is scoped to the page that was edited.** Replacing a whole
  language map — which is what the single-page version did — would wipe every
  other page's text the moment a hotel saved the home page. `saveSiteCopy` now
  replaces only the keys the edited page owns, and drops keys owned by no live
  page at all, so deleting a page or a section doesn't leave copy behind.

Deleting a page purges its copy in **every** language, not just the one on
screen.

Extra pages take the same sections as home minus the two marked `homeOnly`: the
hero (it owns the search form's state) and highlights (its copy lives in
Website → Home, so a second one would just repeat the same three lines). The
page's title renders as the `<h1>`; sections carry their own top margin.

Both the home page and every extra page render through **one** `SectionList` and
load their data through **one** `loadSectionData`, which loads only what the
sections present actually need. With the website off, that same switch renders
the legacy booking-page layout — so there is no second code path to drift.

#### Simple formatting

Prose fields take `**bold**`, `*italic*`, `[label](https://…)`, `- ` bullet lists
and `1. ` numbered lists. Fields opt in with `rich: true` on the field def, which
also drives the syntax hint in the editor — nobody guesses that asterisks do
anything.

`rich-text.ts` parses to a **tree** and `rich-text.tsx` renders that tree as React
elements. There is no `dangerouslySetInnerHTML` anywhere in the path and there
must never be: the tree has four inline shapes and three block shapes, so a
hotel's copy *cannot express* anything else. "No injection" is a property of the
code's structure, not of getting escaping right. Raw HTML in the box comes out as
visible, inert text, and a `[label](javascript:…)` never becomes a link because
only `https?` can match the link branch.

The parser is deliberately conservative, because a lot of copy already exists and
none of it was written with a formatter in mind:

- `_` means nothing — far too common in slugs, emails and filenames to claim.
- `*italic*` must open and close on a non-space, so `5 * 3 metres` is untouched.
- `**` is tried before `*` at the same position, so `**x**` is bold.
- A numbered list keeps the hotel's own first number via `<ol start>`.
- Paragraphs keep their single newlines (`whitespace-pre-line`), so a hotel that
  has never typed a marker gets exactly the line breaks it already had.

That last point is the contract worth protecting: **marker-free text must round
trip byte-for-byte as one text node.** `isPlainText` exists to assert it.

Not applied to the hero intro or the highlights on Website → Home. Those are
short ledes shared with the plain booking page, and the hero's spacing is
load-bearing (see the split-layout fix); they can be added later.

#### Section pictures

A text block takes its own uploaded photos in a column beside the copy — the
shape hotels use for directions, parking, and "how to find the spa". Distinct
from the gallery, which is the property-wide set.

`SiteSection.images` is `{ id, url }[]`: structural, so it is **not** per
language and it travels with the section. Only alt text is translated, under
`${sectionId}.alt_${imageId}` — the same `${owner}.${field}` shape as every other
localized field, so it resolves and gets pruned by the existing code with no
per-image special case. `pageCopyKeys` must list those keys: one missing from
that list looks like garbage to `saveSiteCopy` and is dropped on the next save.

Reordering and removing are ordinary section saves (the images are submitted as
hidden fields in display order), so only the upload needs the server. The upload
button lives inside the whole editor form, and the action saves everything
*before* appending the files — so clicking it never costs you what you just
typed. Blank alt text falls back to the section heading, which is a better
answer than a filename and what a screen reader actually wants.

`imageSide` is stored as `photosRight` / `photosLeft`, not `right` / `left`:
option labels are keyed `secOpt_${value}` and `secOpt_left` already means
left-*aligned* text. On a phone the columns stack and the copy always comes
first — swapped with `lg:order-first`, not by reordering the DOM — because
meeting a photo before the heading tells a guest nothing.

Only one of `align` and `imageSide` is ever shown, since only one ever applies.
A text block with no pictures renders exactly as it did before this existed.

### Phase 2 — custom domain

The hotel wants `spilmanhotel.co.uk/rooms`, not
`spilmanhotel.co.uk/spilmanhotel/rooms`.

Two pieces:

1. **Mount the guest tree a second time at root**, same route modules with
   explicit route ids. The loader resolves the property from `params.channelId`
   *or* the hostname. Reserve the funnel names as property slugs.
2. **`useBase()`** — returns `/${params.channelId}` on the shared domain, `""`
   on a custom domain. Every guest link becomes `` `${base}/rooms` ``.

That second piece is the cost: roughly 40 inline `` `/${params.channelId}/…` ``
links across `app/routes/property/`. Purely mechanical, but wide — worth
isolating on its own branch.

*(Rejected: rewriting the URL at the edge. The server would see `/spilman/rooms`
while the browser has `/rooms`, so client-side navigation would match
`/:channelId` with `channelId = "rooms"` and render the wrong page.)*

---

## 6. Custom domains on Cloudflare

Yes — **Cloudflare for SaaS** (Custom Hostnames) does exactly this, and a Worker
is officially supported as the origin.

### The flow

The hotel adds one DNS record:

```
www.spilmanhotel.co.uk   CNAME   customers.roompanda.com
```

Cloudflare issues and renews the certificate. We do no certificate work.

### Setup on our side

1. Fallback origin as an **originless** record: `customers.roompanda.com AAAA 100::`,
   proxied.
2. Worker route `*/*` on the zone — plus a carve-out, see below.

A wildcard route catches every custom hostname — no per-hostname route, no
deploy when a hotel is added.

**The marketing site shares this zone.** `roompanda.com` serves it (the static
site in `/Users/evan/roompanda`); `book.roompanda.com` is this Worker. Worker
**routes run before Custom Domains** — Cloudflare's docs describe a Custom Domain
Worker as "treated as an origin", with route Workers running ahead of it — so a
bare `*/*` intercepts the marketing site. Add `roompanda.com/*` with **Worker:
None** first, verify the apex still serves marketing, then add `*/*`. Checked
2026-07-30: no `www` record, no wildcard DNS and no MX on the zone, so the apex is
the only carve-out needed. The failure mode is loud, not silent — an intercepted
apex renders the property picker (unknown host → no property → picker) — and
deleting the route reverts it in seconds.

### Resolving hostname → property

Cloudflare's docs are explicit that when a Worker route matches, the
per-hostname `custom_origin_server` setting is **bypassed**, because the Worker
runs before origin resolution. Routing has to happen in our code.

We use a **KV index** (`domain:{hostname}` → propertyId, one key per hostname),
not Cloudflare's `custom_metadata`/`request.cf.hostMetadata`. Metadata would save
a KV read on the request path, but it would be a second copy of the mapping at
the edge, free to drift from the one the admin writes. One source of truth is
worth one KV read.

### Ownership: why the index isn't written on save

Nothing stops a tenant typing `marriott.com` into the domain field, so the index
is written from **Cloudflare's verdict**, never from the form. Two keys per
hostname:

| Key | Meaning | Written when |
|---|---|---|
| `domain-setup:{host}` | this property may set the hostname up | on save (30-day TTL) |
| `domain:{host}` | this property **is served** here | once Cloudflare reports the hostname `active` |

Cloudflare marks a custom hostname active only once the hostname CNAMEs into our
zone (or carries an ownership TXT it issued) — either way that requires control of
the domain. The reservation is what ties that proof to a tenant: Cloudflare
verifies the *domain*, not who asked, so without it any property could ride on the
real owner's proof by polling first.

Activation runs from the admin's "Check status" button **and** from the 6-hourly
cron, because hotels add their DNS record and don't come back to the page.

**One record, not three.** The hotel adds the traffic CNAME and nothing else:
ownership validates from that CNAME, and the certificate uses automatic HTTP DCV
(`ssl.method: "http"`), where Cloudflare serves the CA's token from the edge.

The accepted cost (Evan, 2026-07-30): the certificate can only be issued *after*
the CNAME points here, so there is a window — usually minutes — where the hotel's
domain resolves to us without a valid cert and browsers warn. Removing it means
asking every hotel for a second record, and one beats two when the domain being
pointed at us isn't live yet.

**When to revisit:** a hotel migrating an already-live domain. For them that
window is a real outage, not a blank domain, and they need pre-validation —
either the ownership TXT plus a cert TXT, or better,
[delegated DCV](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/delegated-dcv/):
a permanent `_acme-challenge` CNAME that also makes renewals automatic. Add it as
an "already have a live site?" path, not as everyone's default.

**The CNAME target 301s to the canonical host.** The wildcard route means
`customers.roompanda.com` reaches this Worker like any other hostname, so visiting
it directly served a full working duplicate of `book.roompanda.com` — indexable,
admin login included. `canonicalRedirect` in `workers/app.ts` sends it to
`APP_URL`, path and query intact. Hotel traffic is unaffected: a request for a
hotel's domain keeps that hostname throughout (the Worker runs before origin
resolution), so it never arrives as the CNAME target.

### The apex caveat

`spilmanhotel.co.uk` with no `www` is the one thing that isn't clean. DNS does
not permit a CNAME at the zone root.

- **If their DNS is on Cloudflare** — CNAME flattening handles it, free, nothing
  special from us.
- **If it isn't** — that needs Apex Proxying, which requires static IP prefixes,
  carries a cost, and is gated to certain accounts.

Recommendation: make `www` the canonical hostname, ask for a redirect at the
apex, and treat bare-apex-off-Cloudflare as unsupported at launch. It covers
almost everyone and costs nothing.

### Two gotchas from the docs

- **CNAME validation trades a TLS window for a simpler ask.** Cloudflare
  recommends TXT or HTTP pre-validation because with CNAME validation traffic can
  reach the edge before the certificate issues, and the guest gets a TLS warning
  on the hotel's own domain. We took that trade knowingly — see "One record, not
  three" above for the reasoning and the condition that should reverse it.
- **Never create a custom hostname equal to our own zone name.**

---

## 7. Admin

A new **Website** group in the nav, absorbing the existing Content group:

```
Website
  General          opt in, address, custom domain          (built)
  Sections         home-page section editor                (built)
  Footer           blurb, contact, social, extra links     (built)
  Gallery          property photos                         (built)
  Facilities       property facilities                     (built)
  Pages            extra pages beyond home                 (built)
  Navigation       per-page "show in menu" — a full editor isn't built
  Theme & style    extends the existing theme controls
  Booking screens  today's home / results / detail / checkout editors
```

Custom-domain config, and where each value lives:

| Value | Where | Why |
|---|---|---|
| `CUSTOM_HOSTNAME_TARGET` | `wrangler.jsonc` `vars` | Now that it's chosen, pinning is safer than a dashboard var — a plaintext var not listed in `vars` is dropped on the next deploy |
| `OWN_HOSTS` | `wrangler.jsonc` `vars` | The marketing hostnames on our zone, so no hotel can claim one |
| `CLOUDFLARE_API_TOKEN` | dashboard **secret** | Needs `SSL and Certificates: Edit` on the zone |
| `CLOUDFLARE_ZONE_ID` | dashboard **secret** | Not really secret, but secrets survive deploys and losing it would strand every pending domain |

While the target is unset the General page says custom domains aren't available
rather than printing a target that wouldn't work; while the API credentials are
unset it says activation isn't set up, rather than accepting a domain that would
never serve anything.

The section editor is the bulk of the UI work: add, reorder, hide, and a
settings form per section type, times 14 types, times 8 locales for the copy.

**Skip live preview in v1.** Edit, then "View site" in a new tab. Preview
roughly doubles the build and is the easiest thing to add later.

---

## 8. Phasing

| | Scope | Value |
|---|---|---|
| **1** ✅ | Gallery, facilities, per-page SEO, `<title>` fix | Useful on its own — better cards, better structured data — even if the website never ships |
| **2** ✅ | Section engine + 8 sections, home page only, opt-in | The real v1. A one-page hotel site |
| **3** | Multi-page, nav, footer, templates | A website product — pages, nav and footer done; **templates still to do** |
| **4** | Custom domains | Makes it sellable |
| **5** | Remaining sections, live preview | Polish |

Phase 1 has value independent of the rest, which makes it the right place to
start — if the product stalls after it, nothing is wasted.

## 9. Out of scope

- Blog / news
- User-supplied HTML, CSS or templates
- Multi-property "group" sites — that's what Collections is for
