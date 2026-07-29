import { env } from "cloudflare:workers";

import { getImagesBucket } from "./config.server";

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

export function uploadRoomImage(propertyId: string, roomId: string, file: File): Promise<string> {
  return uploadImage(`rooms/${propertyId}/${roomId}`, file);
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

export function uploadPropertyLogo(propertyId: string, file: File): Promise<string> {
  return uploadImage(`logo/${propertyId}`, file);
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

export function uploadRatePlanImage(
  propertyId: string,
  rateId: string,
  file: File,
): Promise<string> {
  return uploadImage(`rateplans/${propertyId}/${rateId}`, file);
}
