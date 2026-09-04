// POST /admin/rooms/:roomId/photo — store ONE room photo and return its url.
//
// The room editor used to attach every photo to the save itself, which made the
// batch limits in upload-limits.ts unavoidable: one multipart body carried all
// of them, so twelve files / 40 MB was as much as a Worker could be asked to
// buffer. Sending them one at a time makes each request small enough that no
// batch limit is needed, and — because a lone file has a knowable size — lets
// the browser show real progress instead of a button that says "Saving…" for
// four minutes (see admin-photo-uploader.tsx).
//
// The url comes back as a plain string, which is all a room's `images` list
// holds; the editor parks it in a hidden `keepImage` input and the save path is
// unchanged. Nothing here touches the room record: an upload is bytes in R2 and
// nothing more until the admin saves.
//
// Deliberately NOT under /api: the per-teammate area guard reads the URL
// (member-areas.ts maps the `/admin/rooms` prefix to `pricing`), and it runs
// inside currentPropertyId. An /api/… path would map to no area and hand a
// teammate hidden from Rooms an upload endpoint. Declared outside the admin
// layout in routes.ts so it stays a resource route with no chrome to render.
import type { Route } from "./+types/room-photo";
import { requireAdmin } from "~/lib/auth.server";
import { uploadCatalogRoomImage } from "~/lib/images.server";
import { currentPropertyId } from "~/lib/properties.server";
import { mb, MAX_IMAGE_BYTES } from "~/lib/upload-limits";

/** The key prefix segment for this editor's photos. Only cosmetic — ownership
 *  and the GC key off `catalog/<propertyId>/` alone (image-paths.ts) — but it
 *  is still a path, so anything but a plain id is refused rather than
 *  sanitised. A room being created has no id yet and files under `new/`. */
function keySegment(roomId: string | undefined): string | null {
  if (!roomId) return null;
  return /^[A-Za-z0-9_-]{1,64}$/.test(roomId) ? roomId : null;
}

export async function action({ params, request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return Response.json({ error: "No property selected." }, { status: 400 });

  const segment = keySegment(params.roomId);
  if (!segment) return Response.json({ error: "Unknown room." }, { status: 400 });

  // One photo is far below every platform limit, so this should not fire — but
  // an unguarded formData() is exactly how the old multi-file save became an
  // unattributable "unexpected error", and the whole point of this route is
  // that a failure names its file.
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Could not read the upload." }, { status: 400 });
  }

  const file = form.get("photo");
  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ error: "No photo attached." }, { status: 400 });
  }
  // The browser checks this too; this is the one that counts.
  if (file.size > MAX_IMAGE_BYTES) {
    return Response.json(
      { error: `Too large (${mb(file.size)}MB, max ${mb(MAX_IMAGE_BYTES)}MB).` },
      { status: 400 },
    );
  }

  try {
    return Response.json({ url: await uploadCatalogRoomImage(propertyId, segment, file) });
  } catch (e) {
    // uploadImage's own messages ("Only image files are allowed.", "Image
    // storage (R2) is not configured.") are what an admin needs to see, so they
    // are passed through rather than flattened to "Upload failed".
    return Response.json(
      { error: e instanceof Error ? e.message : "Upload failed." },
      { status: 400 },
    );
  }
}
