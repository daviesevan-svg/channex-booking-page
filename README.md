# Channex Booking Engine

A modern, white-label **direct booking engine** for hotels, powered by the
[Channex Shopping API](https://docs.channex.io/for-ota/shopping-api). Guests search
availability, pick a room and rate, and book — all server-rendered for fast first paint
and good SEO, deployable to Cloudflare Workers in one click.

> A ground-up rebuild of the original `instant_booking_page` on a modern stack
> (React Router v7 framework mode + React 19 + Vite + Cloudflare Workers).

## Features

- **Full booking flow** — Search → Rooms → Room detail → Checkout → Confirmation
- **SSR** on Cloudflare Workers (edge-rendered, SEO-friendly, cheap to host)
- **Live availability date picker** — sold-out nights, min-stay rules, and ranges driven
  by `closed_dates`
- **White-label theming** — warm hospitality design with a brand-color accent (one CSS variable)
- **Runtime config** — channel/property/keys are Worker env bindings; change them in the
  dashboard with no rebuild
- **Type-safe Channex client** — `property_info`, `closed_dates`, `rooms`, `best_offer`,
  `property_list`, `push_booking`

## Stack

| | |
|---|---|
| Framework | React Router v7 (framework mode) + React 19 |
| Build | Vite |
| Hosting | Cloudflare Workers (SSR) via `@cloudflare/vite-plugin` |
| Styling | Tailwind CSS v4 |
| Dates | `date-fns` |
| Validation | `zod` |

---

## Quick start (local dev)

Requires **Node 20+** and npm.

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in your values
npm run dev                      # http://localhost:5173
```

Open `http://localhost:5173/<your-property-id>`, or set `DEFAULT_PROPERTY_ID` in
`.dev.vars` to have `/` redirect to your property automatically.

## Configuration

All config is read from Worker env bindings at request time (`.dev.vars` locally,
the Cloudflare dashboard in production). No rebuild needed to change them.

| Variable | Required | Default | Description |
|---|:---:|---|---|
| `CHANNEL_CODE` | ✅ | `OpenShopping` | Channex meta-provider name. `OpenShopping` until you're officially certified, then your own. |
| `DEFAULT_PROPERTY_ID` | – | – | Property UUID. If set, `/` redirects to it (single-hotel deploys). |
| `CHANNEX_API_URL` | – | `https://app.channex.io` | API origin. |
| `PCI_URL` | – | `https://pci.vaultera.co` | Hosted card-capture origin. |
| `GROUP_ID` | – | – | Restrict `property_list` to a group. |
| `GOOGLE_MAP_KEY` | – | – | Google Maps key (optional map features). |
| `ALLOW_LIVE_BOOKING` | – | `false` | When `false`, checkout **simulates** the booking. Set `true` to submit real reservations via `push_booking`. |

> ⚠️ **`ALLOW_LIVE_BOOKING` stays `false` until you're ready.** With it off, the whole
> flow works but no reservation is created — ideal for demos and previews.

---

## Deploy to Cloudflare

### One-click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_ORG/YOUR_REPO)

> Replace `YOUR_ORG/YOUR_REPO` with your fork. The button forks the repo, connects it to
> the user's Cloudflare account, and deploys.

### Connect a Git repo (auto-deploy on push)

1. Fork this repo.
2. In the Cloudflare dashboard → **Workers & Pages → Create → connect your repo**.
   Cloudflare detects the framework and fills in the build command (`npm run build`).
3. Add your env vars (table above) under the project's **Settings → Variables**.
4. Push to `main` → Cloudflare builds and deploys. Every PR gets a preview URL.

### Via CLI

```bash
npm run deploy   # runs `react-router build` then `wrangler deploy`
```

---

## White-label theming

The design is neutral and brand-driven. The accent color is a single CSS variable in
[`app/app.css`](app/app.css):

```css
:root {
  --accent: oklch(0.63 0.13 45);      /* terracotta — map to the hotel's brand color */
  --accent-deep: oklch(0.55 0.14 45); /* darker hover variant */
}
```

Soft tints are derived automatically, so any brand color works. Presets `sage` and `indigo`
are included (apply via `data-theme` on the root). The hotel name, logo, and phone come
from `property_info`.

## Going live

1. Get your **own Channex Booking Engine channel certified** and set `CHANNEL_CODE` to your
   provider name (replaces `OpenShopping`).
2. Wire real **card capture** (Vaultera hosted field via `card_capture_form_url`) for rates
   that require a guarantee — the checkout currently shows a placeholder for "pay at hotel".
3. Set `ALLOW_LIVE_BOOKING=true`.

## Project structure

```
app/
  routes/
    home.tsx                 # "/" → redirects to DEFAULT_PROPERTY_ID
    property/
      layout.tsx             # nav + stepper + footer; loads property_info
      search.tsx             # search + date picker
      results.tsx            # room cards
      detail.tsx             # room detail + rate selection
      checkout.tsx           # guest form + push_booking action (gated)
      confirmation.tsx       # booking recap
  lib/
    channex/                 # typed API client, types, case/query helpers
    config.server.ts         # runtime config from env bindings
    use-date-range.ts        # date-picker logic (closed_dates aware)
    pricing.ts, money.ts, booking-context.ts
  components/calendar-popover.tsx
```

## License

MIT.
