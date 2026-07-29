// Intrinsic pixel size of an uploaded image, read back out of its URL.
//
// Why the URL and not a stored field: image urls are bare strings in six
// different stores (gallery, catalog rooms, extras, vouchers, section pictures,
// and three settings fields). Adding width/height to each would be a migration
// per store for information the uploader already knew. So the uploader bakes it
// into the key — `…/<uuid>-1600x900.webp` — and this reads it back.
//
// An image uploaded before this existed simply has no suffix and returns null;
// callers then render as they always did, without dimensions.

export interface ImageSize {
  width: number;
  height: number;
}

/** Cap on either dimension we'd ever store, so a corrupt or hand-edited url
 *  can't produce an absurd layout box. */
const MAX_DIM = 20000;

/** `…-1600x900.webp` → `{ width: 1600, height: 900 }`, else null. */
export function imageSize(url: string | undefined | null): ImageSize | null {
  if (!url) return null;
  const m = /-(\d{1,5})x(\d{1,5})\.[a-z0-9]+$/i.exec(url);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!width || !height || width > MAX_DIM || height > MAX_DIM) return null;
  return { width, height };
}

/**
 * `width`/`height` props for an `<img>`, or nothing when the size is unknown.
 *
 * These are the intrinsic pixels, NOT the display size: the browser uses the
 * ratio to reserve the right box before the bytes arrive, and CSS still decides
 * how big it actually draws. That is what stops the page jumping as images load.
 */
export function imageDimensionProps(
  url: string | undefined | null,
): { width: number; height: number } | Record<string, never> {
  const size = imageSize(url);
  return size ? { width: size.width, height: size.height } : {};
}
