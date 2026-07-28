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
| `rooms` | `CatalogRoom` | heading, which/how many, grid or carousel, show "from" price |
| `gallery` | **new** gallery | heading, grid or masonry |
| `facilities` | **new** facilities | heading, columns |
| `richText` | — | heading, body, image, image side |
| `reviews` | `reviews.server` | heading, min rating, count |
| `offers` | promotions | heading |
| `extras` | extras catalog | heading |
| `vouchers` | voucher catalog | heading |
| `map` | lat/lng, address | heading, zoom, directions copy |
| `faq` | — | question/answer pairs |
| `contact` | phone, email, address | heading, form on/off |
| `cta` | — | heading, text, button + target |

Registry in `app/lib/sections.ts` (pure — type, label, settings schema,
defaults). Components in `app/components/sections/`.

**Rich text takes no raw HTML.** A small allowlist renderer: bold, italic, link,
list, heading. An injection hole on a hotel's own domain, on a site that also
takes card details, is not a trade worth making for markup convenience.

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
`results.tsx`. Page slugs must be validated on save against the funnel names —
otherwise a hotel creates a page called "rooms" that can never be reached.
Mirror the existing `RESERVED_SLUGS` approach.

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

1. Fallback origin as an **originless** record: `service.roompanda.com AAAA 100::`
2. Worker route `*/*` on the zone.

A wildcard route catches every custom hostname — no per-hostname route, no
deploy when a hotel is added.

### Resolving hostname → property

Cloudflare's docs are explicit that when a Worker route matches, the
per-hostname `custom_origin_server` setting is **bypassed**, because the Worker
runs before origin resolution. Routing has to happen in our code.

Use **custom metadata**: store `{ propertyId }` on the custom hostname when we
create it, then read `request.cf.hostMetadata` at the edge. No KV lookup on the
request path.

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

- **Don't use CNAME validation.** Cloudflare recommends TXT or HTTP
  pre-validation instead: with CNAME validation, traffic can reach the edge
  before the certificate issues, and the guest gets a TLS warning on the hotel's
  own domain. Pre-validate, *then* have them cut DNS over.
- **Never create a custom hostname equal to our own zone name.**

---

## 7. Admin

A new **Website** group in the nav, absorbing the existing Content group:

```
Website
  Pages            list, add, reorder; section editor per page
  Navigation       menu + footer
  Theme & style    extends the existing theme controls
  Gallery          property photos
  Facilities       property facilities
  Domain           custom hostname status + instructions
  Booking screens  today's home / results / detail / checkout editors
```

The section editor is the bulk of the UI work: add, reorder, hide, and a
settings form per section type, times 14 types, times 8 locales for the copy.

**Skip live preview in v1.** Edit, then "View site" in a new tab. Preview
roughly doubles the build and is the easiest thing to add later.

---

## 8. Phasing

| | Scope | Value |
|---|---|---|
| **1** | Gallery, facilities, per-page SEO, `<title>` fix | Useful on its own — better cards, better structured data — even if the website never ships |
| **2** | Section engine + 6 core sections, home page only, opt-in | The real v1. A one-page hotel site |
| **3** | Multi-page, nav, footer, templates | A website product |
| **4** | Custom domains | Makes it sellable |
| **5** | Remaining sections, live preview | Polish |

Phase 1 has value independent of the rest, which makes it the right place to
start — if the product stalls after it, nothing is wasted.

## 9. Out of scope

- Blog / news
- User-supplied HTML, CSS or templates
- Multi-property "group" sites — that's what Collections is for
