// Presentational website sections.
//
// These are the parts of the home page that are pure display — they take data
// and render it. The hero and the highlights stay in the route, because they're
// wired to the search form's state and lifting that out would mean threading a
// dozen values through here for no gain.
//
// The markup is lifted verbatim from the booking landing page, so with the
// website layer off the page renders exactly what it always did.

import { Link } from "react-router";

import type { Translator } from "~/lib/i18n";
import { SECTION_DEFS, numberSetting, type SiteSection } from "~/lib/sections";
import { RichText } from "~/components/rich-text";
import { imageProps, IMAGE_SIZES } from "~/lib/image-srcset";
import type { ResolvedGalleryImage } from "~/lib/gallery";
import type { ReviewView } from "~/lib/section-data";
import { facilityLabelKey } from "~/lib/content";

export type { ReviewView };

/**
 * Star gold, dark enough to be a legible graphic.
 *
 * #f5b301 sat at 1.85:1 on a review card. This clears 3:1 — the bar for a
 * graphical object that carries meaning — rather than the 4.5:1 text bar, which
 * would need roughly #9f6100 and no longer reads as a star rating. The glyphs are
 * `aria-hidden` with the score on an `aria-label`, so they are a labelled image
 * rather than text.
 */
const STAR_GOLD = "#bf7f00";

/** A section's own heading, else the translated default for its type. */
export function sectionHeading(
  section: Pick<SiteSection, "type"> & { text?: Record<string, string> },
  tr: Translator,
): string {
  const own = section.text?.heading?.trim();
  if (own) return own;
  const key = SECTION_DEFS[section.type].headingKey;
  return key ? tr.t(key) : "";
}

export function Diamond({ size = 9, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      className={`inline-block flex-none rounded-mark bg-accent ${className}`}
      style={{ width: size, height: size, transform: "rotate(45deg)" }}
    />
  );
}

interface Common {
  section: SiteSection & { text?: Record<string, string> };
  tr: Translator;
}

// ---------------------------------------------------------------- highlights

export function HighlightsSection({
  highlights,
}: {
  highlights: { title: string; description: string }[];
}) {
  if (!highlights.length) return null;
  return (
    <div className="mt-12 grid max-w-[920px] grid-cols-1 gap-[18px] sm:grid-cols-3">
      {highlights.map((h, i) => (
        <div key={i} className="flex items-start gap-3.5">
          <Diamond className="mt-1.5" />
          <div>
            <div className="mb-0.5 text-body-lg font-semibold">{h.title}</div>
            <div className="text-sm leading-[1.5] text-muted">{h.description}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- facilities

export function FacilitiesSection({
  section,
  tr,
  facilities,
  facilitiesExtra,
}: Common & { facilities: string[]; facilitiesExtra: string[] }) {
  if (!facilities.length && !facilitiesExtra.length) return null;
  return (
    <div className="mt-12 max-w-[920px]">
      <h2 className="mb-5 font-serif text-title-3xl font-semibold">{sectionHeading(section, tr)}</h2>
      <ul className="grid grid-cols-1 gap-x-8 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {facilities.map((key) => (
          <li key={key} className="flex items-start gap-3 text-body-lg">
            <Diamond className="mt-[7px]" size={7} />
            {tr.t(facilityLabelKey(key))}
          </li>
        ))}
        {facilitiesExtra.map((line, i) => (
          <li key={`x${i}`} className="flex items-start gap-3 text-body-lg">
            <Diamond className="mt-[7px]" size={7} />
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------- reviews

export function ReviewsSection({
  section,
  tr,
  reviews,
  hotelName,
}: Common & {
  reviews: { average: number; count: number; reviews: ReviewView[] };
  hotelName: string;
}) {
  const minStars = numberSetting(section, "minStars", 1);
  const limit = numberSetting(section, "limit", 4);
  const shown = reviews.reviews.filter((r) => r.stars >= minStars).slice(0, limit);
  if (reviews.count === 0 || shown.length === 0) return null;

  return (
    <div className="mt-12 max-w-[920px]">
      <div className="mb-5 flex items-baseline gap-3">
        <h2 className="font-serif text-title-3xl font-semibold">{sectionHeading(section, tr)}</h2>
        <span className="text-body text-secondary">
          {/* Decorative: the figure follows it. */}
          <span aria-hidden style={{ color: STAR_GOLD }}>★</span>{" "}
          <span className="font-semibold text-ink">{reviews.average}</span>/5 · {reviews.count}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-[18px] sm:grid-cols-2">
        {shown.map((r) => (
          <div key={r.id} className="rounded-card-lg border border-line bg-surface p-5">
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <span className="text-body font-semibold">{r.guestName}</span>
              <span
                className="text-caption"
                style={{ color: STAR_GOLD, letterSpacing: 1 }}
                role="img"
                aria-label={`${r.stars}/5`}
              >
                <span aria-hidden>
                  {"★".repeat(r.stars)}
                  <span style={{ color: "#ddd5c8" }}>{"★".repeat(5 - r.stars)}</span>
                </span>
              </span>
            </div>
            <p className="text-body leading-[1.6] text-secondary">{r.publicText}</p>
            {r.response?.text && (
              <div className="mt-3 border-l-2 border-line-alt pl-3">
                <div className="text-micro font-semibold uppercase tracking-wide text-muted-2">
                  {tr.t("hotelResponse", { hotel: hotelName })}
                </div>
                <p className="mt-0.5 text-caption leading-[1.55] text-muted">{r.response.text}</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ vouchers

export function VouchersSection({
  section,
  tr,
  hasVouchers,
  onOpen,
}: Common & { hasVouchers: boolean; onOpen: () => void }) {
  if (!hasVouchers) return null;
  const body = section.text?.body?.trim() || tr.t("vouchersTeaserBody");
  return (
    <div className="mt-12 flex max-w-[920px] flex-wrap items-center justify-between gap-4 rounded-panel-lg border border-line bg-surface px-7 py-6">
      <div>
        <h2 className="mb-1 font-serif text-title-xl font-semibold">{sectionHeading(section, tr)}</h2>
        <div className="max-w-[520px]">
          <RichText text={body} className="text-body leading-[1.55] text-muted" />
        </div>
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="flex-none cursor-pointer rounded-card border border-accent px-6 py-3 text-body-lg font-semibold text-accent hover:bg-accent-soft"
      >
        {tr.t("vouchersTeaserCta")}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------- gallery

export function GallerySection({
  section,
  tr,
  gallery,
  hotelName,
  fallbackPhoto,
}: Common & {
  gallery: ResolvedGalleryImage[];
  hotelName: string;
  /** Shown when there's no gallery — the single ambiance image the booking page
   *  has always ended on, so turning nothing on loses nothing. */
  fallbackPhoto?: string;
}) {
  const limit = numberSetting(section, "limit", 12);
  const photos = gallery.slice(0, limit);

  if (photos.length === 0) {
    return (
      <div className="relative mt-12 h-[300px] overflow-hidden rounded-panel-lg">
        {fallbackPhoto ? (
          <img
            {...imageProps(fallbackPhoto, IMAGE_SIZES.full)}
            alt={hotelName}
            className="h-full w-full object-cover"
          />
        ) : (
          <div
            className="h-full w-full"
            style={{
              background:
                "repeating-linear-gradient(135deg,#efe7da,#efe7da 13px,#e7ddcc 13px,#e7ddcc 26px)",
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="mt-12">
      <h2 className="mb-5 font-serif text-title-3xl font-semibold">{sectionHeading(section, tr)}</h2>
      <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-4">
        {photos.map((photo) => (
          <figure key={photo.id}>
            <div className="aspect-[4/3] overflow-hidden rounded-card-lg bg-surface-alt">
              <img
                {...imageProps(photo.url, IMAGE_SIZES.galleryGrid)}
                alt={photo.alt ?? hotelName}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </div>
            {photo.caption && (
              <figcaption className="mt-1.5 text-label leading-[1.45] text-muted">
                {photo.caption}
              </figcaption>
            )}
          </figure>
        ))}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------- rooms

export interface RoomCardView {
  id: string;
  title: string;
  description?: string;
  photo?: string;
  maxGuests: number;
}

export function RoomsSection({
  section,
  tr,
  rooms,
  channelId,
}: Common & { rooms: RoomCardView[]; channelId: string }) {
  const limit = numberSetting(section, "limit", 6);
  const shown = rooms.slice(0, limit);
  if (!shown.length) return null;
  const intro = section.text?.intro?.trim();

  return (
    <div className="mt-12 scroll-mt-24" id="rooms">
      <h2 className="mb-2 font-serif text-title-3xl font-semibold">{sectionHeading(section, tr)}</h2>
      {intro && (
        <div className="mb-5 max-w-[620px]">
          <RichText text={intro} className="text-body-lg leading-[1.6] text-muted" />
        </div>
      )}
      <div className={`grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 ${intro ? "" : "mt-5"}`}>
        {shown.map((room) => (
          <div
            key={room.id}
            className="flex flex-col overflow-hidden rounded-panel border border-line bg-surface"
          >
            {/* flex-none + overflow-hidden are load-bearing: this box is a flex
                item, so its default `min-height: auto` lets a tall photo push it
                past the 3/2 ratio. Landscape photos looked fine and portrait
                ones didn't, which is why the cards came out uneven. */}
            <div className="aspect-[3/2] w-full flex-none overflow-hidden bg-surface-alt">
              {room.photo ? (
                <img
                  {...imageProps(room.photo, IMAGE_SIZES.roomCard)}
                  alt={room.title}
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div
                  className="h-full w-full"
                  style={{
                    background:
                      "repeating-linear-gradient(135deg,#efe7da,#efe7da 13px,#e7ddcc 13px,#e7ddcc 26px)",
                  }}
                />
              )}
            </div>
            <div className="flex flex-1 flex-col p-5">
              <h3 className="mb-1 font-serif text-title-sm font-semibold">{room.title}</h3>
              <div className="mb-2 text-caption text-muted-2">
                {tr.t("sleeps", { n: room.maxGuests })}
              </div>
              {room.description && (
                <p className="mb-4 line-clamp-3 text-body leading-[1.55] text-secondary">
                  {room.description}
                </p>
              )}
              {/* No price here on purpose: a nightly rate depends on dates, and
                  a "from" figure with no dates and no taxes would be a number
                  we'd have to walk back at checkout. */}
              <Link
                to={`/${channelId}/room/${room.id}`}
                className="mt-auto inline-block self-start rounded-control border border-accent px-4 py-2 text-body font-semibold text-accent hover:bg-accent-soft"
              >
                {tr.t("secRoomsCta")}
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- rich text

export function RichTextSection({
  section,
  hotelName,
}: Pick<Common, "section"> & { hotelName?: string }) {
  const heading = section.text?.heading?.trim();
  const body = section.text?.body?.trim();
  const images = section.images ?? [];
  if (!heading && !body && !images.length) return null;

  const copy = (
    <div>
      {heading && <h2 className="mb-3 font-serif text-title-3xl font-semibold">{heading}</h2>}
      {body && <RichText text={body} className="text-lead leading-[1.7] text-secondary" />}
    </div>
  );

  // Text-only keeps the old single narrow column exactly as it was, centring
  // included — a section a hotel already wrote must not move.
  if (!images.length) {
    const centered = (section.settings?.align ?? "left") === "center";
    return (
      <div className={`mt-12 max-w-[720px] ${centered ? "mx-auto text-center" : ""}`}>{copy}</div>
    );
  }

  // With pictures it becomes two columns, so the copy no longer runs the width
  // of the page on its own. `align` deliberately doesn't apply here.
  // "Photos on the left" is a two-column choice. Stacked on a phone the copy
  // always comes first — arriving on "Parking Info" and meeting a photo before
  // the heading tells you nothing — so the order is swapped in CSS at lg, not by
  // reordering the DOM.
  const left = section.settings?.imageSide === "photosLeft";
  const stack = (
    <div className={`flex flex-col gap-4 ${left ? "lg:order-first" : ""}`}>
      {images.map((img) => (
        <img
          key={img.id}
          {...imageProps(img.url, IMAGE_SIZES.sectionColumn)}
          // Hotels skip alt text; the heading is a far better fallback than the
          // filename, and it's what a screen reader would want to hear here.
          alt={section.text?.[`alt_${img.id}`] || heading || hotelName || ""}
          loading="lazy"
          // h-auto so the intrinsic width/height above don't fix the drawn size.
          className="h-auto w-full rounded-card-lg border border-line bg-surface-alt"
        />
      ))}
    </div>
  );

  return (
    <div className="mt-12 grid grid-cols-1 items-start gap-10 lg:grid-cols-2">
      {copy}
      {stack}
    </div>
  );
}
