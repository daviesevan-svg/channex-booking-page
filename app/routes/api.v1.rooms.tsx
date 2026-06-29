import type { Route } from "./+types/api.v1.rooms";
import { authenticateApiKey } from "~/lib/api-auth.server";
import { getRooms } from "~/lib/catalog.server";
import { serializeRoom } from "~/lib/api-serialize";

// GET /v1/rooms — unpriced room content (cards: title, description, images, facilities).
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request);
  if (auth instanceof Response) return auth;
  const rooms = await getRooms(auth.pid);
  return Response.json({ data: rooms.map(serializeRoom) });
}
