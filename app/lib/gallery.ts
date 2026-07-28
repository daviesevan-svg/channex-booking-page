// Property photo gallery — pure types and helpers (safe on the client).
//
// Rooms have their own `images[]`; this is the PROPERTY-level set: the pictures
// a hotel website opens with. Structure (which images, in what order) is stored
// once and is language-independent; alt text and captions are per language, so
// translating a caption can never reorder or drop an image.

/** Hard cap per property. Generous for a hotel gallery, small enough that the
 *  whole set stays one modest KV value and the admin page renders in one go. */
export const MAX_GALLERY_IMAGES = 40;

export interface GalleryImage {
  /** Stable id — survives reordering, and keys the per-language text. */
  id: string;
  /** /images/… path (R2). */
  url: string;
}

export interface GalleryText {
  /** Alt text. Falls back to the default language, then to the hotel name. */
  alt?: string;
  caption?: string;
}

export interface Gallery {
  images: GalleryImage[];
  /** lang → imageId → text */
  text: Record<string, Record<string, GalleryText>>;
}

/** One image with its text resolved for a given language. */
export interface ResolvedGalleryImage extends GalleryImage {
  alt?: string;
  caption?: string;
}

export const emptyGallery = (): Gallery => ({ images: [], text: {} });

/** Merge `lang` text over the default-language text, per field, so a partly
 *  translated gallery still renders a complete caption rather than a blank. */
export function resolveGallery(
  gallery: Gallery,
  lang: string,
  defaultLang: string,
): ResolvedGalleryImage[] {
  const base = gallery.text[defaultLang] ?? {};
  const loc = gallery.text[lang] ?? {};
  return gallery.images.map((img) => ({
    ...img,
    alt: loc[img.id]?.alt || base[img.id]?.alt || undefined,
    caption: loc[img.id]?.caption || base[img.id]?.caption || undefined,
  }));
}

/** Reorder `ids` to match the given order, dropping unknown ids and appending
 *  any image the caller forgot to mention (so a stale form can't delete). */
export function applyOrder(images: GalleryImage[], order: string[]): GalleryImage[] {
  const byId = new Map(images.map((i) => [i.id, i]));
  const out: GalleryImage[] = [];
  for (const id of order) {
    const img = byId.get(id);
    if (img) {
      out.push(img);
      byId.delete(id);
    }
  }
  return [...out, ...byId.values()];
}
