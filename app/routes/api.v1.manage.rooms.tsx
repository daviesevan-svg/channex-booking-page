import type { Route } from "./+types/api.v1.manage.rooms";
import { authenticateApiKey } from "~/lib/api-auth.server";
import { getRooms } from "~/lib/catalog.server";
import { serializeManageRoom } from "~/lib/manage-serialize";

// GET /v1/manage/rooms — the full admin room records (incl. translations),
// unlike the guest GET /v1/rooms which localizes and trims.
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await authenticateApiKey(request, "manage");
  if (auth instanceof Response) return auth;
  const rooms = await getRooms(auth.pid);
  return Response.json({ data: rooms.map(serializeManageRoom) });
}
