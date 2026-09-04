// POST /admin/gallery/photo — store ONE gallery image and add it to the gallery.
//
// The same change as room-photo.tsx, for the uploader that had the same
// problem: every picked file rode on one multipart POST, so the batch had to
// stay under what a Worker can buffer and there was no progress to show while
// it went. One request per file removes both.
//
// Unlike a room's photos, a gallery upload has always BEEN the write — the old
// action stored the files and called addImages in the same submit, with no
// staging step. That is kept: this endpoint commits, and the page revalidates
// to show the new image in the grid it already renders. So there is no orphan
// to reclaim here, and nothing for the save path to know about.
//
// addImages is read-modify-write on a single KV key, which two concurrent
// uploads would clobber. The uploader drains its queue one file at a time, so
// these arrive in series — the same guarantee the old one-batch-one-write
// comment relied on, by a different route.
//
// URL under /admin/gallery so the per-teammate area guard (member-areas.ts maps
// that prefix to `website`) covers it inside currentPropertyId; declared
// outside the admin layout in routes.ts so it stays a resource route.
import type { Route } from "./+types/gallery-photo";
import { requireAdmin } from "~/lib/auth.server";
import { addImages, getGallery } from "~/lib/gallery.server";
import { MAX_GALLERY_IMAGES } from "~/lib/gallery";
import { queueImageCleanup } from "~/lib/image-gc.server";
import { uploadGalleryImage } from "~/lib/images.server";
import { currentPropertyId } from "~/lib/properties.server";
import { imageProblem, imageProblemMessage } from "~/lib/upload-limits";

const FULL = `The gallery is full (max ${MAX_GALLERY_IMAGES}). Remove one first.`;

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const propertyId = await currentPropertyId(request);
  if (!propertyId) return Response.json({ error: "No property selected." }, { status: 400 });

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
  const problem = imageProblem(file);
  if (problem) return Response.json({ error: imageProblemMessage(problem) }, { status: 400 });

  // Checked before the bytes are spent, so a full gallery fails at once instead
  // of after an upload. Per file, "the gallery is full" is a definite answer
  // about THIS photo — the old batch said "3 image(s) not added" and never
  // which three.
  if ((await getGallery(propertyId)).images.length >= MAX_GALLERY_IMAGES) {
    return Response.json({ error: FULL }, { status: 400 });
  }

  try {
    const url = await uploadGalleryImage(propertyId, file);
    const { added } = await addImages(propertyId, [url]);
    if (!added) {
      // addImages caps internally, so this is the check above losing a race
      // with another tab. The bytes are already in R2 and now referenced by
      // nothing, so hand them straight back to the GC rather than leak them.
      queueImageCleanup(propertyId, [url]);
      return Response.json({ error: FULL }, { status: 400 });
    }
    return Response.json({ url });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Upload failed." }, { status: 400 });
  }
}
