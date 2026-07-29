// Ask the image server for the size a slot actually needs.
//
// Uploads are stored as the hotel sent them — often straight off a phone, and up
// to the 8 MB cap. Rendering that into a 300px card downloads roughly forty times
// the pixels it draws. These helpers build the `srcset`/`sizes` pair that lets
// the browser pick, and app/routes/image.tsx does the resizing.
//
// Pure, so the guest renderer and the tests share one definition of the ladder.

import { imageSize } from "./image-size";

/**
 * The only widths the image server will produce.
 *
 * A closed set on purpose: every distinct width is a billed transformation and a
 * separate cache entry, so an open `?w=` would let anyone run up the bill by
 * walking 1..2048. Roughly 1.5x apart, which is about the point where a step is
 * worth a separate download.
 */
export const IMAGE_WIDTHS = [320, 480, 640, 960, 1280, 1600, 2048] as const;

/** Fallback `src` for browsers with no srcset support, and the width the
 *  preloader fetches. Mid-ladder: never the multi-megabyte original. */
const DEFAULT_WIDTH = 960;

/** Only our own R2-backed uploads can be resized. The room editor also accepts
 *  pasted absolute urls, which belong to someone else's server. */
export function isResizable(url: string | undefined | null): boolean {
  return Boolean(url && url.startsWith("/images/"));
}

/** The same image at one ladder width. */
export function imageAt(url: string, width: number): string {
  return isResizable(url) ? `${url}?w=${width}` : url;
}

/**
 * A `srcset` for `url`, or undefined when there's nothing useful to offer.
 *
 * Never lists a width above the image's own: upscaling costs bytes and adds
 * nothing. When the intrinsic size is unknown (an upload from before it was
 * recorded) the whole ladder is offered — the server clamps anyway, so the worst
 * case is a couple of identical candidates.
 */
export function imageSrcSet(url: string | undefined | null): string | undefined {
  if (!url || !isResizable(url)) return undefined;
  const intrinsic = imageSize(url)?.width;
  const widths = intrinsic
    ? IMAGE_WIDTHS.filter((w) => w <= intrinsic)
    : [...IMAGE_WIDTHS];
  // An image smaller than the narrowest rung: one candidate is pointless.
  if (widths.length === 0) return undefined;
  return widths.map((w) => `${imageAt(url, w)} ${w}w`).join(", ");
}

/**
 * `sizes` tells the browser how wide the slot will be before any CSS has loaded,
 * so it has to be described in viewport terms — and it has to be ACCURATE. Get it
 * wrong and srcset is worse than useless: an over-stated slot makes the browser
 * pick a bigger candidate than it needs, which is the problem this was meant to
 * fix. A first pass here claimed `33vw` for the gallery, which is 4-up at
 * desktop, and the browser duly fetched 960px for a 266px box.
 *
 * The shell is `max-w-[1160px] px-7`, so content is `min(100vw, 1160px) - 56px`.
 * The subtractions below are that padding plus the grid's gaps. These mirror the
 * grids in components/sections.tsx and were measured against them — change the
 * two together.
 */
export const IMAGE_SIZES = {
  /** Gallery: 2-up, 3-up ≥640, 4-up ≥1024. gap-3.5 = 14px. */
  galleryGrid:
    "(min-width: 1160px) 266px, (min-width: 1024px) calc((100vw - 98px) / 4), (min-width: 640px) calc((100vw - 84px) / 3), calc((100vw - 70px) / 2)",
  /** Room cards: 1-up, 2-up ≥640, 3-up ≥1024. gap-6 = 24px. */
  roomCard:
    "(min-width: 1160px) 352px, (min-width: 1024px) calc((100vw - 104px) / 3), (min-width: 640px) calc((100vw - 80px) / 2), calc(100vw - 56px)",
  /** Hero photo beside the copy: the 1fr of `1.1fr 1fr`, gap-10 = 40px. */
  heroSplit:
    "(min-width: 1160px) 507px, (min-width: 1024px) calc((100vw - 96px) / 2.1), calc(100vw - 56px)",
  /** A text block's picture column: half of a 2-col grid, gap-10 = 40px. */
  sectionColumn:
    "(min-width: 1160px) 532px, (min-width: 1024px) calc((100vw - 96px) / 2), calc(100vw - 56px)",
  /** Something running the full content width. */
  full: "(min-width: 1160px) 1104px, calc(100vw - 56px)",
} as const;

/** Everything an `<img>` needs for one of our uploads: a sane `src`, a `srcset`,
 *  and the intrinsic `width`/`height` so the box is reserved before it loads. */
export function imageProps(
  url: string | undefined | null,
  sizes: string,
): {
  src: string | undefined;
  srcSet?: string;
  sizes?: string;
  width?: number;
  height?: number;
} {
  if (!url) return { src: undefined };
  const srcSet = imageSrcSet(url);
  const size = imageSize(url);
  return {
    src: isResizable(url) ? imageAt(url, DEFAULT_WIDTH) : url,
    ...(srcSet ? { srcSet, sizes } : {}),
    ...(size ? { width: size.width, height: size.height } : {}),
  };
}
