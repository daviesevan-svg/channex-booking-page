// Presentational website sections.
//
// These are the parts of the home page that are pure display — they take data
// and render it. The hero and the highlights stay in the route, because they're
// wired to the search form's state and lifting that out would mean threading a
// dozen values through here for no gain.
//
// The markup is lifted verbatim from the booking landing page, so with the
// website layer off the page renders exactly what it always did.

import type { Translator } from "~/lib/i18n";
import { SECTION_DEFS, numberSetting, type SiteSection } from "~/lib/sections";
import type { ResolvedGalleryImage } from "~/lib/gallery";
import { facilityLabelKey } from "~/lib/content";

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
      className={`inline-block flex-none rounded-[1px] bg-accent ${className}`}
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
            <div className="mb-0.5 text-[15px] font-semibold">{h.title}</div>
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
      <h2 className="mb-5 font-serif text-[24px] font-semibold">{sectionHeading(section, tr)}</h2>
      <ul className="grid grid-cols-1 gap-x-8 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {facilities.map((key) => (
          <li key={key} className="flex items-start gap-3 text-[15px]">
            <Diamond className="mt-[7px]" size={7} />
            {tr.t(facilityLabelKey(key))}
          </li>
        ))}
        {facilitiesExtra.map((line, i) => (
          <li key={`x${i}`} className="flex items-start gap-3 text-[15px]">
            <Diamond className="mt-[7px]" size={7} />
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------- reviews

export interface ReviewView {
  id: string;
  guestName: string;
  stars: number;
  publicText: string;
  response?: { text?: string } | null;
}

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
        <h2 className="font-serif text-[24px] font-semibold">{sectionHeading(section, tr)}</h2>
        <span className="text-[14px] text-secondary">
          <span style={{ color: "#f5b301" }}>★</span>{" "}
          <span className="font-semibold text-ink">{reviews.average}</span>/5 · {reviews.count}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-[18px] sm:grid-cols-2">
        {shown.map((r) => (
          <div key={r.id} className="rounded-[14px] border border-line bg-surface p-5">
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <span className="text-[14px] font-semibold">{r.guestName}</span>
              <span
                className="text-[13px]"
                style={{ color: "#f5b301", letterSpacing: 1 }}
                aria-label={`${r.stars}/5`}
              >
                {"★".repeat(r.stars)}
                <span style={{ color: "#ddd5c8" }}>{"★".repeat(5 - r.stars)}</span>
              </span>
            </div>
            <p className="text-[14px] leading-[1.6] text-secondary">{r.publicText}</p>
            {r.response?.text && (
              <div className="mt-3 border-l-2 border-line-alt pl-3">
                <div className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-2">
                  {tr.t("hotelResponse", { hotel: hotelName })}
                </div>
                <p className="mt-0.5 text-[13px] leading-[1.55] text-muted">{r.response.text}</p>
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
    <div className="mt-12 flex max-w-[920px] flex-wrap items-center justify-between gap-4 rounded-[18px] border border-line bg-surface px-7 py-6">
      <div>
        <h2 className="mb-1 font-serif text-[22px] font-semibold">{sectionHeading(section, tr)}</h2>
        <p className="max-w-[520px] text-[14px] leading-[1.55] text-muted">{body}</p>
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="flex-none cursor-pointer rounded-[12px] border border-accent px-6 py-3 text-[15px] font-semibold text-accent hover:bg-accent-soft"
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
      <div className="relative mt-12 h-[300px] overflow-hidden rounded-[18px]">
        {fallbackPhoto ? (
          <img src={fallbackPhoto} alt={hotelName} className="h-full w-full object-cover" />
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
      <h2 className="mb-5 font-serif text-[24px] font-semibold">{sectionHeading(section, tr)}</h2>
      <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-4">
        {photos.map((photo) => (
          <figure key={photo.id}>
            <div className="aspect-[4/3] overflow-hidden rounded-[14px] bg-surface-alt">
              <img
                src={photo.url}
                alt={photo.alt ?? hotelName}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </div>
            {photo.caption && (
              <figcaption className="mt-1.5 text-[12.5px] leading-[1.45] text-muted">
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

export function RoomsSection({ section, tr, rooms }: Common & { rooms: RoomCardView[] }) {
  const limit = numberSetting(section, "limit", 6);
  const shown = rooms.slice(0, limit);
  if (!shown.length) return null;
  const intro = section.text?.intro?.trim();

  return (
    <div className="mt-12">
      <h2 className="mb-2 font-serif text-[24px] font-semibold">{sectionHeading(section, tr)}</h2>
      {intro && (
        <p className="mb-5 max-w-[620px] whitespace-pre-line text-[15px] leading-[1.6] text-muted">
          {intro}
        </p>
      )}
      <div className={`grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 ${intro ? "" : "mt-5"}`}>
        {shown.map((room) => (
          <div
            key={room.id}
            className="flex flex-col overflow-hidden rounded-[16px] border border-line bg-surface"
          >
            <div className="aspect-[3/2] bg-surface-alt">
              {room.photo ? (
                <img
                  src={room.photo}
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
              <h3 className="mb-1 font-serif text-[19px] font-semibold">{room.title}</h3>
              <div className="mb-2 text-[13px] text-muted-2">
                {tr.t("sleeps", { n: room.maxGuests })}
              </div>
              {room.description && (
                <p className="mb-4 line-clamp-3 text-[14px] leading-[1.55] text-secondary">
                  {room.description}
                </p>
              )}
              {/* No price here on purpose: a nightly rate depends on dates, and
                  a "from" figure with no dates and no taxes would be a number
                  we'd have to walk back at checkout. */}
              <a
                href="#book"
                className="mt-auto inline-block self-start rounded-[10px] border border-accent px-4 py-2 text-[14px] font-semibold text-accent hover:bg-accent-soft"
              >
                {tr.t("secRoomsCta")}
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- rich text

export function RichTextSection({ section }: Pick<Common, "section">) {
  const heading = section.text?.heading?.trim();
  const body = section.text?.body?.trim();
  if (!heading && !body) return null;
  const centered = (section.settings?.align ?? "left") === "center";
  return (
    <div className={`mt-12 max-w-[720px] ${centered ? "mx-auto text-center" : ""}`}>
      {heading && <h2 className="mb-3 font-serif text-[24px] font-semibold">{heading}</h2>}
      {body && (
        <p className="whitespace-pre-line text-[16px] leading-[1.7] text-secondary">{body}</p>
      )}
    </div>
  );
}
