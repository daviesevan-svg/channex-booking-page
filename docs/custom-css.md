# Custom CSS for the guest pages

A property can attach its own stylesheet to every guest-facing page: the
website, the booking funnel, the extras and checkout steps, the confirmation
page, the voucher shop, the guest manage pages and the embeddable date-picker
widget. It is never applied to the admin.

Where to set it:

- **Admin** → Website → Design → *Colour & type* → *Advanced: custom CSS*.
- **API** → `PATCH /v1/manage/brand` with `{ "custom_css": "…" }` (`null` clears).
- **MCP** → the `update_brand` tool, field `custom_css`.

Limits: 20 000 characters. `<` is escaped and `@import` is removed on save.
External stylesheets and fonts are blocked by the page's Content-Security-Policy
anyway; pick a typeface from the *Typeface* list, which is self-hosted.

The sheet is rendered **after** the theme, so on equal specificity your rule
wins. This page is the vocabulary it can target. Paste it into your AI
assistant together with a description of the look you want.

## How the theme is built

Every colour, corner radius and type size on a guest page is a CSS custom
property. The utilities read `var(--…)`, so redefining a variable restyles
every place that uses it, with no selector hunting.

The variables live on the wrapper element `.ui-root`, some of them as an
**inline style** (the accent, the page colour, a template's radii and fonts).
An inline style beats a stylesheet rule of any specificity, so a variable
override at the root needs `!important`:

```css
.ui-root { --radius-control: 9999px !important; }
```

Rules on the hook classes below do not need `!important` unless you are
fighting a utility that sets the same property (see *Hook classes*).

Redefining a variable **on an element** re-scopes it for that element and its
descendants only. That is how you get, for example, dark cards on a light page:

```css
.ui-card { --color-surface: #07595b; --color-ink: #ffffff; }
```

## Design tokens

### Accent and page (inline on `.ui-root`, override with `!important`)

| Variable | Used for |
| --- | --- |
| `--accent` | Primary buttons, links, selected dates, the progress bar, the mark |
| `--accent-deep` | Hover state of the primary button |
| `--on-accent` | Text on an accent-filled button |
| `--accent-soft`, `--accent-soft-strong` | Tints: selected chips, soft highlights |
| `--page` | The page background |

The colour pickers in the admin run these through a contrast check and adjust
them until text is legible. A value set here bypasses that check.

### Neutrals (default light palette; a dark page background swaps the whole set)

| Variable | Used for |
| --- | --- |
| `--color-surface` | Cards, the sticky summary, popovers |
| `--color-surface-alt` | Input backgrounds, the footer, quiet panels |
| `--color-ink` | Body text |
| `--color-secondary`, `--color-muted`, `--color-muted-2`, `--color-faint`, `--color-faint-2` | Progressively quieter text |
| `--color-line`, `--color-line-alt`, `--color-divider` | Borders and hairlines |
| `--color-chip`, `--color-chip-border` | Small tags |
| `--color-field-hover` | Input hover |
| `--color-nav-border` | The header's bottom border |
| `--color-disabled-day` | Unavailable calendar days |
| `--color-success`, `--color-success-soft`, `--color-success-line` | Confirmations |
| `--color-danger`, `--color-danger-soft`, `--color-danger-line` | Errors |
| `--color-notice`, `--color-notice-soft`, `--color-notice-line`, `--color-caution` | Warnings, sold-out notes |
| `--color-info`, `--color-info-soft` | Informational notes |

### Corners

| Variable | Default | Used for |
| --- | --- | --- |
| `--radius-mark` | 1px | The diamond marker |
| `--radius-chip` | 8px | Pills and small icon buttons |
| `--radius-control` | 10px | Inputs, secondary buttons |
| `--radius-card` | 12px | Cards **and the primary button** |
| `--radius-panel` | 16px | Panels, popovers, large photos |
| `--radius-well` | 20px | Modals and the largest surfaces |

The primary button shares `--radius-card` with cards, so to make buttons pills
without rounding cards, use the hook class rather than the variable:

```css
.ui-btn-primary, .ui-btn-secondary { border-radius: 9999px; }
```

### Type scale

| Variable | Default | Used for |
| --- | --- | --- |
| `--text-micro` | 11px | Badges, superscript labels |
| `--text-label` | 12px | Uppercase eyebrows, field labels |
| `--text-caption` | 13px | Form labels, meta, errors |
| `--text-body` | 14px | Body copy |
| `--text-body-lg` | 15px | Prose and inputs |
| `--text-lead` | 16px | Lead paragraphs |
| `--text-title-sm` | 18px | Card titles |
| `--text-title-md` | 20px | Section titles, the header wordmark |
| `--text-title-lg` | 24px | Section headings |
| `--text-display-sm` | 28px | Page titles |
| `--text-display-md` | 34px | Large headings |
| `--text-display-lg` | 40px | Hero-size headings |
| `--text-display-xl` | 56px | Hero headline |

Scaling body text to 18px:

```css
.ui-root {
  --text-body: 16px !important;
  --text-body-lg: 18px !important;
  --text-lead: 19px !important;
  font-weight: 500;
}
```

### Fonts

| Variable | Used for |
| --- | --- |
| `--font-sans` | Body text |
| `--font-serif` | Headings and the wordmark |

Only families in the *Typeface* picker are loaded. To use the body family for
headings too: `.ui-root { --font-serif: var(--font-sans) !important; }`.

## Hook classes

Stable class names on the recurring elements. They carry no styling of their
own; the visual classes beside them may change between releases, the hooks will
not. Where a hook element also has a utility that sets the same property (for
example the logo's height), add `!important`.

### Page chrome

| Class | Element |
| --- | --- |
| `.ui-root` | The wrapper around every guest page (and the widget) |
| `.ui-header` | The sticky header |
| `.ui-logo` | The logo image (`height: 40px; max-width: 220px` by default) |
| `.ui-wordmark` | The hotel name in the header |
| `.ui-mark` | The diamond mark shown when there is no logo |
| `.ui-footer` | The footer block |

```css
.ui-logo { height: 56px !important; max-width: 320px !important; }
.ui-header > div { justify-content: center; }   /* centre the logo */
```

### Components (the style slots)

| Class | Element |
| --- | --- |
| `.ui-btn-primary` | The money button: search, select, continue, pay |
| `.ui-btn-secondary` | The quieter button beside it |
| `.ui-cta-outline` | The outlined button on the vouchers strip |
| `.ui-link-outline` | Outlined text links |
| `.ui-field` | Input chrome (border, background, corners) |
| `.ui-card` | A small card: one review, the contact form |
| `.ui-panel` | A larger panel |
| `.ui-well` | A recessed area |
| `.ui-strip` | A full-width strip |
| `.ui-media`, `.ui-media-large` | Photo frames |
| `.ui-rule` | A hairline between rows |
| `.ui-page`, `.ui-gap`, `.ui-measure`, `.ui-measure-prose` | Page container, vertical rhythm, reading widths |
| `.ui-hero-display`, `.ui-hero-inner`, `.ui-page-head`, `.ui-heading-align` | Hero and page-head layout |
| `.ui-split-row`, `.ui-split-media`, `.ui-split-prose` | Two-column text-and-photo sections |
| `.ui-highlights-grid`, `.ui-facilities-grid`, `.ui-reviews-grid`, `.ui-gallery-grid`, `.ui-gallery-tile`, `.ui-rooms-grid`, `.ui-room-photo`, `.ui-offers-grid` | Section grids |

Where the hooks appear: `.ui-btn-primary` is on the results page's select and
continue buttons, the offer and voucher pages, the consent banner and the
website sections. The card, panel, field and grid hooks are on the website
sections and the search page. Elements without a hook (the checkout form and
its pay button, the calendar, the sticky summary) take every colour, corner and
size from the tokens above, so a token override on `.ui-root` reaches them.

## Worked example

Peach pill buttons with dark teal text, dark teal cards, Montserrat Medium at
18px, a larger logo:

```css
/* Buttons */
.ui-btn-primary {
  background: #faa26f;
  color: #07595b;
  border: 1px solid #f28a45;
  border-radius: 9999px;
  padding: 14px 28px;
}
.ui-btn-primary:hover { background: #f8945a; }
.ui-btn-secondary { border-radius: 9999px; }

/* Dark cards on a light page: re-scope the neutrals inside the card */
.ui-card {
  --color-surface: #07595b;
  --color-ink: #ffffff;
  --color-secondary: #e6f0ef;
  --color-muted: #cfe3e2;
  --color-line: #0f6e70;
}

/* Type */
.ui-root {
  --text-body: 16px !important;
  --text-body-lg: 18px !important;
  --text-lead: 19px !important;
  font-weight: 500;
}

/* Logo */
.ui-logo { height: 56px !important; max-width: 320px !important; }
```

## Things to check after you save

- **Contrast.** The pickers keep text legible; the sheet does not. Check text on
  buttons and on any recoloured card, including muted text and links.
- **Every step.** Open the results, room, extras, checkout and confirmation
  pages, and the widget if you embed it. A re-scoped card variable also applies
  to inputs and status messages inside that card.
- **Both templates' behaviour.** If you later switch template, the template's
  own variables are applied inline and your `!important` overrides still win.
