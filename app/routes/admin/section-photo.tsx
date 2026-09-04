// POST /admin/website/sections/photo — store ONE section image and attach it.
//
// The third of the three batched uploaders (see room-photo.tsx for why), and
// the one whose old shape cost the most: the upload button was a submit inside
// the page's whole copy form, so attaching a photo also saved every text field
// on the page, and every photo went up in that one body. Now the photo is its
// own request and saving the copy is a separate, deliberate act.
//
// Which section a photo belongs to used to be carried by the clicked button's
// `uploadFor`; it now travels as a field on the request, alongside the page.
//
// Like the gallery, an upload here has always been the write — addSectionImages
// commits it — so the page revalidates to show it and there is no staging step.
// That helper is read-modify-write on one KV key; the uploader drains its queue
// one file at a time, so these arrive in series.
//
// URL under /admin/website so the per-teammate area guard (member-areas.ts maps
// that prefix to `website`) covers it inside currentPropertyId; declared
// outside the admin layout in routes.ts so it stays a resource route.
import type { Route } from "./+types/section-photo";
import { requireAdmin } from "~/lib/auth.server";
import { queueImageCleanup } from "~/lib/image-gc.server";
import { uploadSectionImage } from "~/lib/images.server";
import { currentPropertyId } from "~/lib/properties.server";
import { MAX_SECTION_IMAGES } from "~/lib/sections";
import { addSectionImages } from "~/lib/site.server";
import { mb, MAX_IMAGE_BYTES } from "~/lib/upload-limits";

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

  const pageId = String(form.get("pageId") ?? "");
  const sectionId = String(form.get("sectionId") ?? "");
  if (!pageId || !sectionId) return Response.json({ error: "Unknown section." }, { status: 400 });

  const file = form.get("photo");
  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ error: "No photo attached." }, { status: 400 });
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return Response.json(
      { error: `Too large (${mb(file.size)}MB, max ${mb(MAX_IMAGE_BYTES)}MB).` },
      { status: 400 },
    );
  }

  try {
    const url = await uploadSectionImage(propertyId, file);
    const { added } = await addSectionImages(propertyId, pageId, sectionId, [url]);
    if (!added) {
      // Either the section is full or the page/section/type does not take
      // images at all — addSectionImages does not distinguish, and from here
      // the honest thing is not to guess. Either way the bytes are stored and
      // referenced by nothing, so they go back to the GC rather than leak.
      queueImageCleanup(propertyId, [url]);
      return Response.json(
        { error: `Not added — a section holds at most ${MAX_SECTION_IMAGES} images.` },
        { status: 400 },
      );
    }
    return Response.json({ url });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Upload failed." }, { status: 400 });
  }
}
