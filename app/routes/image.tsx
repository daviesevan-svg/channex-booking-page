import type { Route } from "./+types/image";
import { getImagesBucket } from "~/lib/config.server";

// Public resource route: serves an uploaded image from R2 at /images/<key>.
export async function loader({ params }: Route.LoaderArgs) {
  const key = params["*"];
  const bucket = getImagesBucket();
  if (!bucket || !key) throw new Response("Not found", { status: 404 });

  const object = await bucket.get(key);
  if (!object) throw new Response("Not found", { status: 404 });

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: object.httpEtag,
    },
  });
}
