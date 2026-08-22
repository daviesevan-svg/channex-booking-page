import { env } from "cloudflare:workers";

import { getImagesBucket } from "./config.server";
import { isAllowedImportImageParsed } from "./image-import-url";

const MAX_BYTES = 8 * 1024 * 1024; // 8MB

/**
 * The image's pixel size, as a `-WxH` filename suffix.
 *
 * Read once here rather than stored, because image urls are bare strings in six
 * different stores and adding a field to each would be six migrations for
 * something the upload already knows. `imageSize()` reads it back off the url so
 * guest pages can reserve the right box before the bytes arrive. Returns "" if
 * Images can't read the file — the image still works, just without dimensions.
 */
async function sizeSuffix(bytes: ArrayBuffer): Promise<string> {
  const transformer = (env as unknown as { IMAGE_TRANSFORM?: ImagesBinding }).IMAGE_TRANSFORM;
  if (!transformer) return "";
  try {
    const info = await transformer.info(
      new Response(bytes).body as ReadableStream<Uint8Array>,
    );
    const w = "width" in info ? info.width : 0;
    const h = "height" in info ? info.height : 0;
    return w > 0 && h > 0 && w < 20000 && h < 20000 ? `-${w}x${h}` : "";
  } catch {
    return "";
  }
}

/**
 * Resolve one optional image field off an admin form: a freshly attached file
 * wins (stored via `upload`), then an explicit remove, then the previous
 * value. The seven hand-rolled copies of this disagreed on the remove-flag
 * encoding ("1" / any value / truthy) and each had its own fallback error
 * string; this is the one implementation. The caller still owns persisting
 * the value and GC'ing a replaced file — those are genuinely per-store.
 */
export async function resolveImageField(
  form: FormData,
  opts: {
    /** Form field holding the File (read via getAll — some pickers post several inputs). */
    fileKey: string;
    /** Checkbox field requesting removal; any truthy value counts. */
    removeKey: string;
    previous: string | undefined;
    upload: (file: File) => Promise<string>;
  },
): Promise<{ ok: true; url: string | undefined } | { ok: false; error: string }> {
  const file = form.getAll(opts.fileKey).find((f): f is File => f instanceof File && f.size > 0);
  if (file) {
    try {
      return { ok: true, url: await opts.upload(file) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Image upload failed." };
    }
  }
  if (form.get(opts.removeKey)) return { ok: true, url: undefined };
  return { ok: true, url: opts.previous };
}

/** Store an uploaded image in R2 under the given key prefix and return the path
 *  to serve it (/images/<key>). */
async function uploadImage(prefix: string, file: File): Promise<string> {
  const bucket = getImagesBucket();
  if (!bucket) throw new Error("Image storage (R2) is not configured.");
  if (!file.type.startsWith("image/")) throw new Error("Only image files are allowed.");
  if (file.size > MAX_BYTES) throw new Error("Image is too large (max 8MB).");

  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  // The uploaded name is otherwise discarded — the key is a uuid so a hostile
  // filename can't shape the path.
  const bytes = await file.arrayBuffer();
  const key = `${prefix}/${crypto.randomUUID()}${await sizeSuffix(bytes)}.${ext}`;
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: file.type },
  });
  return `/images/${key}`;
}

/** Fetch one hop at a time so a 3xx cannot land on an internal host. Each
 *  Location is re-checked against the same allowlist (webhooks do this too). */
async function fetchAllowlistedImage(start: URL): Promise<Response> {
  let current = start;
  for (let hop = 0; hop < 3; hop++) {
    if (!isAllowedImportImageParsed(current)) {
      throw new Error("Only Booking.com CDN image URLs can be imported.");
    }
    const res = await fetch(current.toString(), { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`Image fetch failed (${res.status}).`);
      current = new URL(loc, current);
      continue;
    }
    return res;
  }
  throw new Error("Image fetch failed (too many redirects).");
}

/** Fetch an image by URL (the Booking.com onboarding import) and store it in R2
 *  like an upload. Same guards as uploadImage — type, size, uuid key — plus a
 *  host allowlist inside this function (https + `*.bstatic.com`) so a crafted
 *  payload can't make the Worker fetch internal endpoints. Content type comes
 *  from the response, extension from the type (CDN URLs carry query-string
 *  tokens that would pollute a name-derived extension). */
export async function importImageFromUrl(prefix: string, url: string): Promise<string> {
  const parsed = new URL(url);
  if (!isAllowedImportImageParsed(parsed)) {
    throw new Error("Only Booking.com CDN image URLs can be imported.");
  }
  const bucket = getImagesBucket();
  if (!bucket) throw new Error("Image storage (R2) is not configured.");
  const res = await fetchAllowlistedImage(parsed);
  if (!res.ok) throw new Error(`Image fetch failed (${res.status}).`);
  const type = res.headers.get("content-type")?.split(";")[0].trim() ?? "";
  if (!type.startsWith("image/")) throw new Error("URL did not return an image.");
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) throw new Error("Image is too large (max 8MB).");
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif", "image/gif": "gif" }[type] ?? "jpg";
  const key = `${prefix}/${crypto.randomUUID()}${await sizeSuffix(bytes)}.${ext}`;
  await bucket.put(key, bytes, { httpMetadata: { contentType: type } });
  return `/images/${key}`;
}

export function uploadHomeImage(propertyId: string, file: File): Promise<string> {
  return uploadImage(`home/${propertyId}`, file);
}

export function uploadPropertyCoverImage(propertyId: string, file: File): Promise<string> {
  return uploadImage(`cover/${propertyId}`, file);
}

export function uploadGalleryImage(propertyId: string, file: File): Promise<string> {
  return uploadImage(`gallery/${propertyId}`, file);
}

/** A picture belonging to one website section (a text block's photo column).
 *  Not keyed by section id — the section it belongs to is recorded in the page
 *  config, and a re-ordered or re-created section shouldn't orphan the file. */
export function uploadSectionImage(propertyId: string, file: File): Promise<string> {
  return uploadImage(`sections/${propertyId}`, file);
}

/** White-label partner brand assets (admin chrome, login, favicon). Keyed by
 *  partner id, not property — they belong to the PMS, not any hotel. */
export function uploadPartnerLogo(partnerId: string, file: File): Promise<string> {
  return uploadImage(`partners/${partnerId}/logo`, file);
}
export function uploadPartnerFavicon(partnerId: string, file: File): Promise<string> {
  return uploadImage(`partners/${partnerId}/favicon`, file);
}

export function uploadPropertyLogo(propertyId: string, file: File): Promise<string> {
  return uploadImage(`logo/${propertyId}`, file);
}

export function uploadPropertyFavicon(propertyId: string, file: File): Promise<string> {
  return uploadImage(`favicon/${propertyId}`, file);
}

export function uploadCatalogRoomImage(propertyId: string, roomId: string, file: File): Promise<string> {
  return uploadImage(`catalog/${propertyId}/${roomId}`, file);
}

export function uploadExtraImage(propertyId: string, extraId: string, file: File): Promise<string> {
  return uploadImage(`extras/${propertyId}/${extraId}`, file);
}

export function uploadVoucherImage(propertyId: string, productId: string, file: File): Promise<string> {
  return uploadImage(`vouchers/${propertyId}/${productId}`, file);
}
