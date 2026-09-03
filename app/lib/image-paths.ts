// Which /images/… paths belong to a property.
//
// Every property upload lands under `<root>/<propertyId>/…` (images.server.ts);
// partner brand assets live under `partners/<partnerId>/…` and the Google feed
// snapshots under `feeds/…`, in the SAME bucket. The GC treated any `/images/`
// url as a candidate and only spared keys some property still referenced — so
// a room `images` list naming a partner's logo, saved and then saved again
// without it, deleted that logo for every hotel under the partner. Same for
// the feed snapshot, whose key is a public constant.
//
// Two rules, shared by the GC and the management API validators:
//  * a property may only DELETE keys under its own `<root>/<pid>/` prefixes;
//  * a payload may only REFERENCE property-upload paths (any property's — a
//    clone legitimately points at its source's keys), never partner or feed
//    objects.
// Pure module: no bindings, safe in validators and tests.

export const PROPERTY_IMAGE_ROOTS = [
  "home",
  "cover",
  "gallery",
  "sections",
  "logo",
  "favicon",
  "manage",
  "catalog",
  "extras",
  "vouchers",
] as const;

export const IMAGE_PATH = "/images/";

const OWNED_KEY_RE = new RegExp(`^(?:${PROPERTY_IMAGE_ROOTS.join("|")})/([^/]+)/[^/].*$`);

/** The property id a bucket key was uploaded for, or null for anything that is
 *  not a property upload (partner assets, feed snapshots, legacy keys). */
export function propertyImageOwner(key: string): string | null {
  const m = OWNED_KEY_RE.exec(key);
  return m ? m[1] : null;
}

/** True when `key` was uploaded for `pid` — the only keys `pid` may delete. */
export function ownsImageKey(pid: string, key: string): boolean {
  return !!pid && propertyImageOwner(key) === pid;
}

/** True for an `/images/<root>/<somePid>/…` url — a reference a payload may
 *  carry. Not scoped to one pid on purpose: cloneProperty copies the source's
 *  urls verbatim, and re-saving a clone must not 422. */
export function isPropertyImageUrl(url: unknown): url is string {
  if (typeof url !== "string" || !url.startsWith(IMAGE_PATH)) return false;
  const key = url.slice(IMAGE_PATH.length);
  return !key.includes("..") && propertyImageOwner(key) !== null;
}

export const IMAGE_URL_HINT = "must be an /images/<kind>/<property>/… path from POST /v1/manage/images or /images/import";
