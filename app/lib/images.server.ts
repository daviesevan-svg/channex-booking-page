import { getImagesBucket } from "./config.server";

const MAX_BYTES = 8 * 1024 * 1024; // 8MB

/** Store an uploaded image in R2 under the given key prefix and return the path
 *  to serve it (/images/<key>). */
async function uploadImage(prefix: string, file: File): Promise<string> {
  const bucket = getImagesBucket();
  if (!bucket) throw new Error("Image storage (R2) is not configured.");
  if (!file.type.startsWith("image/")) throw new Error("Only image files are allowed.");
  if (file.size > MAX_BYTES) throw new Error("Image is too large (max 8MB).");

  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const key = `${prefix}/${crypto.randomUUID()}.${ext}`;
  await bucket.put(key, await file.arrayBuffer(), {
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

export function uploadCatalogRoomImage(propertyId: string, roomId: string, file: File): Promise<string> {
  return uploadImage(`catalog/${propertyId}/${roomId}`, file);
}

export function uploadRatePlanImage(
  propertyId: string,
  rateId: string,
  file: File,
): Promise<string> {
  return uploadImage(`rateplans/${propertyId}/${rateId}`, file);
}
