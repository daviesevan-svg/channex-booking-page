import type { Route } from "./+types/api.v1.manage.rooms.$id";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { deleteRoom, getRoom, saveRoom } from "~/lib/catalog.server";
import { DEFAULT_LANG } from "~/lib/content";
import { queueGoogleAriPush } from "~/lib/google-ari/push.server";
import { queueImageCleanup } from "~/lib/image-gc.server";
import { serializeManageRoom } from "~/lib/manage-serialize";
import { validateRoomInput, validationError } from "~/lib/manage-validate";
import { buildRoom } from "./api.v1.manage.rooms";

// GET /v1/manage/rooms/:id · PATCH (sparse merge) · DELETE (cascades: the
// room's price is removed from every rate — deleteRoom owns that).
export async function loader({ request, params }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const room = await getRoom(auth.pid, String(params.id ?? ""));
  if (!room) return apiError(404, "not_found", "No room with that id.");
  return Response.json({ data: serializeManageRoom(room) });
}

export async function action({ request, params }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const room = await getRoom(auth.pid, String(params.id ?? ""));
  if (!room) return apiError(404, "not_found", "No room with that id.");

  if (request.method === "DELETE") {
    await deleteRoom(auth.pid, room.id);
    queueImageCleanup(auth.pid, room.images);
    await queueGoogleAriPush(auth.pid, ["property_data", "ari"]);
    return Response.json({ deleted: true, cascade: "The room's price was removed from every rate plan." });
  }

  if (request.method === "PATCH") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "bad_request", "Body must be JSON.");
    }
    const parsed = validateRoomInput(body, { create: false, defaultLang: DEFAULT_LANG });
    if (!parsed.ok) return validationError(parsed.errors);
    const next = buildRoom(parsed.value, room);
    // Cross-field rule checked on the MERGED record — a sparse PATCH may send
    // only one of the pair, and the contradiction only exists after the merge.
    if (next.maxGuests < next.maxAdults) {
      return validationError({ max_guests: ["Must be ≥ max_adults (guests = adults + children)."] });
    }
    await saveRoom(auth.pid, next);
    const kept = new Set(next.images);
    queueImageCleanup(auth.pid, room.images.filter((u) => !kept.has(u)));
    await queueGoogleAriPush(auth.pid, ["property_data", "ari"]);
    return Response.json({ data: serializeManageRoom(next) });
  }

  return apiError(405, "method_not_allowed", "Use PATCH to edit or DELETE to remove.");
}
