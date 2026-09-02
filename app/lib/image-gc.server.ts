// Reclaim R2 image objects that nothing references any more.
//
// Every uploaded image lives in R2 and is referenced by url (`/images/<key>`,
// see images.server.ts) from a KV content store. Removing an image in the admin
// only rewrites that KV store, so without this pass the object stays in the
// bucket for ever.
//
// Two rules make this safe to call from a save path:
//
//  * Best-effort, and off the response path. A failed scan or a failed delete is
//    logged and dropped — leaking a file is a rounding error; failing an admin's
//    edit because the bucket hiccuped is not.
//  * Never delete a url something still points at. The check spans EVERY
//    property, not just the one being edited, because cloneProperty copies
//    gallery / catalog_rooms / extras / settings / content verbatim: a clone's
//    rows reference the SOURCE property's R2 keys (see clone-property.server.ts,
//    which says so). A per-property check would let one hotel's edit delete
//    another hotel's live photos.
//
// KV's eventual consistency works in our favour: a stale read still contains the
// url that was just removed, so the worst case is that a file survives this pass
// — never that a referenced one is deleted.
//
//  * Only the editing property's OWN objects. Uploads are keyed
//    `<root>/<pid>/…` (image-paths.ts); partner logos (`partners/…`) and the
//    Google feed snapshots (`feeds/…`) share the bucket and are referenced by
//    nothing `referencedBy` scans — so before this rule a room `images` list
//    naming a partner's logo, saved twice, deleted that logo for every hotel
//    under the partner. Another property's keys are never ours to delete
//    either; the cross-property scan above protects a clone's SOURCE from the
//    source's own edits, this protects everything from everyone else's.
//
// ANY new store that holds an image url must be added to `referencedBy` below.
// Missing one there is the only way this can delete a live image.
import { fireAndForget } from "~/lib/d1.server";

import { getRooms } from "./catalog.server";
import { getImagesBucket } from "./config.server";
import { getExtras } from "./extras.server";
import { getGallery } from "./gallery.server";
import { getHeroImage, getSettings } from "./overrides.server";
import { ownsImageKey, IMAGE_PATH as IMAGE_PATH_PREFIX } from "./image-paths";
import { getProperties } from "./properties.server";
import { siteImageUrls } from "./site.server";
import { getVoucherProducts, voucherSnapshotImages } from "./vouchers.server";

const IMAGE_PATH = IMAGE_PATH_PREFIX;

/** Scanning one property costs 8 reads (7 KV + 1 D1) and a Worker allows 1000
 *  subrequests per request, so 100 properties is ~810 including the save that
 *  triggered this. Past this many the sweep is skipped and logged rather than
 *  risk a half-finished scan concluding "unreferenced" — the leak comes back,
 *  but nothing live is deleted. A reverse index (key → referrers) is the upgrade
 *  if this ever gets hit. */
const MAX_SWEEP_PROPERTIES = 100;

/**
 * The R2 key behind one of our uploaded-image urls, or null for anything we
 * don't own.
 *
 * A filter, not just string surgery: the room editor also accepts pasted
 * absolute urls, and KV can be hand-edited, so a value reaching bucket.delete()
 * has to be one we know we wrote.
 */
export function imageKeyOf(url: unknown): string | null {
  if (typeof url !== "string" || !url.startsWith(IMAGE_PATH)) return null;
  const key = url.slice(IMAGE_PATH.length);
  if (!key || key.includes("..")) return null;
  return key;
}

/** Every image url one property's stores still point at. Hidden sections and
 *  inactive extras count — they're still referenced, just not rendered. */
async function referencedBy(pid: string): Promise<string[]> {
  const [gallery, sections, rooms, extras, vouchers, sold, settings, hero] = await Promise.all([
    getGallery(pid),
    siteImageUrls(pid),
    getRooms(pid),
    getExtras(pid),
    getVoucherProducts(pid),
    // Sold vouchers freeze a copy of the product, so a catalog image can still be
    // live on something a guest paid for after it's gone from the catalog.
    voucherSnapshotImages(pid),
    getSettings(pid),
    getHeroImage(pid),
  ]);
  return [
    ...gallery.images.map((i) => i.url),
    ...sections,
    ...rooms.flatMap((r) => r.images),
    ...extras.map((e) => e.image),
    ...vouchers.map((v) => v.image),
    ...sold,
    settings.coverImage,
    settings.logoImage,
    settings.faviconImage,
    hero,
  ].filter((u): u is string => typeof u === "string" && u.length > 0);
}

/**
 * Delete the R2 objects behind `removed` that no store references any more.
 *
 * Callers pass the urls their save dropped; this decides whether each is really
 * orphaned. Never throws — see the file header.
 */
export async function deleteUnreferencedImages(pid: string, removed: string[]): Promise<void> {
  const bucket = getImagesBucket();
  if (!bucket) return;

  const candidates = new Map<string, string>(); // url → R2 key
  for (const url of removed) {
    const key = imageKeyOf(url);
    // Not ours to delete: another property's upload, a partner asset, a feed
    // snapshot, or a legacy key without an owner. Leaking a file is a rounding
    // error; deleting someone else's is not.
    if (key && ownsImageKey(pid, key)) candidates.set(url, key);
  }
  if (!candidates.size) return;

  // The property that was just edited is where a surviving reference is most
  // likely to be (the same photo used by another section, or re-added while
  // this one was removed), so check it first — that alone ends the common case
  // without touching any other property.
  for (const url of await referencedBy(pid)) candidates.delete(url);
  if (!candidates.size) return;

  const others = (await getProperties()).filter((p) => p.id !== pid);
  if (others.length > MAX_SWEEP_PROPERTIES) {
    console.warn(
      `image gc: ${others.length} properties is more than one request can scan — keeping ${candidates.size} image(s) rather than risk deleting a referenced one`,
    );
    return;
  }
  for (const p of others) {
    for (const url of await referencedBy(p.id)) candidates.delete(url);
    if (!candidates.size) return;
  }

  // One try/catch per object: a single unlucky key must not strand the rest.
  for (const [url, key] of candidates) {
    try {
      await bucket.delete(key);
    } catch (err) {
      console.error(`image gc: could not delete ${url}`, err);
    }
  }
}

/** Fire-and-forget wrapper: the sweep runs past the response (falling back to a
 *  floating promise outside a request context, e.g. dev), so a slow scan or a
 *  bucket outage can neither delay nor fail the save that triggered it. */
export function queueImageCleanup(pid: string, removed: string[]): void {
  if (!removed.length) return;
  fireAndForget(
    deleteUnreferencedImages(pid, removed).catch((err) => console.error("image gc: sweep failed", err)),
  );
}
