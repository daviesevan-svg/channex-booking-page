import type { Route } from "./+types/api.v1.manage.rooms";
import { apiError, authenticateApiKey } from "~/lib/api-auth.server";
import { getRooms, replaceRooms, saveRoom, type CatalogRoom } from "~/lib/catalog.server";
import { DEFAULT_LANG } from "~/lib/content";
import { queueGoogleAriPush } from "~/lib/google-ari/push.server";
import { queueImageCleanup } from "~/lib/image-gc.server";
import { serializeManageRoom } from "~/lib/manage-serialize";
import { validateRoomInput, validationError, type RoomInput } from "~/lib/manage-validate";

// GET  /v1/manage/rooms — the full admin room records (incl. translations).
// POST /v1/manage/rooms — create a room.
// PUT  /v1/manage/rooms — replace the whole room list in one write (re-import
//      semantics; retained ids keep their createdAt).
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const rooms = await getRooms(auth.pid);
  return Response.json({ data: rooms.map(serializeManageRoom) });
}

export function buildRoom(input: RoomInput, base: CatalogRoom): CatalogRoom {
  return {
    ...base,
    title: input.title ?? base.title,
    description: input.description === undefined ? base.description : (input.description ?? undefined),
    images: input.images ?? base.images,
    maxAdults: input.maxAdults ?? base.maxAdults,
    maxGuests: input.maxGuests ?? base.maxGuests,
    cleaningFee: input.cleaningFee === undefined ? base.cleaningFee : input.cleaningFee || undefined,
    facilities: input.facilities ?? base.facilities,
    amenities: input.amenities ?? base.amenities,
    position: input.position ?? base.position,
    translations: input.translations === undefined ? base.translations : Object.keys(input.translations ?? {}).length ? input.translations : undefined,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "bad_request", "Body must be JSON.");
  }

  if (request.method === "POST") {
    const parsed = validateRoomInput(body, { create: true, defaultLang: DEFAULT_LANG });
    if (!parsed.ok) return validationError(parsed.errors);
    const rooms = await getRooms(auth.pid);
    const room = buildRoom(parsed.value, {
      id: crypto.randomUUID(),
      title: "",
      images: [],
      maxAdults: 1,
      maxGuests: 1,
      facilities: [],
      position: rooms.length,
      createdAt: new Date().toISOString(),
    });
    await saveRoom(auth.pid, room);
    await queueGoogleAriPush(auth.pid, ["property_data", "ari"]);
    return Response.json({ data: serializeManageRoom(room) }, { status: 201 });
  }

  if (request.method === "PUT") {
    if (!Array.isArray(body)) return apiError(422, "validation_error", "PUT takes a JSON array of rooms (the full list).");
    const existing = await getRooms(auth.pid);
    const byId = new Map(existing.map((r) => [r.id, r]));
    const next: CatalogRoom[] = [];
    for (let i = 0; i < body.length; i++) {
      const item = body[i] as Record<string, unknown>;
      const id = typeof item?.id === "string" && item.id.trim() ? item.id.trim() : crypto.randomUUID();
      const { id: _id, ...rest } = (item ?? {}) as Record<string, unknown>;
      const parsed = validateRoomInput(rest, { create: true, defaultLang: DEFAULT_LANG });
      if (!parsed.ok) return validationError(Object.fromEntries(Object.entries(parsed.errors).map(([k, v]) => [`[${i}].${k}`, v])));
      const base = byId.get(id);
      next.push(
        buildRoom(parsed.value, {
          id,
          title: "",
          images: [],
          maxAdults: 1,
          maxGuests: 1,
          facilities: [],
          position: i,
          createdAt: base?.createdAt ?? new Date().toISOString(),
          translations: base?.translations,
        }),
      );
      next[next.length - 1].position = i; // list order IS the ordering
    }
    await replaceRooms(auth.pid, next);
    const kept = new Set(next.flatMap((r) => r.images));
    queueImageCleanup(auth.pid, existing.flatMap((r) => r.images).filter((u) => !kept.has(u)));
    await queueGoogleAriPush(auth.pid, ["property_data", "ari"]);
    return Response.json({ data: next.map(serializeManageRoom) });
  }

  return apiError(405, "method_not_allowed", "Use POST to create or PUT to replace the list.");
}
